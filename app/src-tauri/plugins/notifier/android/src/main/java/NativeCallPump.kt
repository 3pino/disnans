package dev.disnans.notifier

import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * 音声 I/O の純粋なポンプ（Android 依存なし）。
 *
 * キャプチャ側: Recorder.read を繰り返し呼び、部分読みを FRAME まで溜めてから
 *   - マイク音量の適用 (int16ToFloat → gain → clamp → floatToInt16)
 *   - 無音ゲート (NativeSilenceGate)
 *   - sender へ渡す（stop/mute 後のコールバックは抑制する）
 *
 * 再生側: mixer.mixBlock を呼び、Player.write で書く。部分書き込みを続けて書く。
 *
 * 安全方針:
 *   - stop() は running を即座に無効化し、両 Recorder と Player を止める
 *   - onFailure は 1 回だけ呼ぶ（AtomicBoolean で保護）
 *   - ミュート中は Recorder.read を呼ばない（ビジーループなし）
 *   - n==0: AudioRecord の stopped/unblocked 状態。capture 値に関わらず安全な continue。
 *     epoch（setCapture の呼び出し回数）が変わった場合のみ途中フレームを破棄。
 *     連続 0 が 3 回を超えたら 5ms のバックオフ（ドライバー quirk でのビジーループ防止）。
 *   - n<0: AudioRecord ドライバーエラーコード。running && capture のときだけ fail。
 *   - stop/mute 後のフレームコールバックは running/capture を 2 段でチェックして抑制
 *   - 重複 ownership（markRunning を 2 回）は require で拒否
 *
 * NativeCallAudio がスレッドを作り、captureLoop/playLoop を呼ぶ。
 */
internal class NativeCallPump(
    private val recorder: Recorder,
    private val player: Player,
    private val sender: (seq: Long, pcm: ByteArray) -> Unit,
    private val onFailure: (code: String) -> Unit,
) {
    // ---- ポートインターフェース ----

    /** マイクの抽象（ブロッキング読み）。n > 0: 読めたサンプル数。n=0: 止まった/unblocked（エラーでない）。n<0: エラー */
    interface Recorder {
        fun read(buf: ShortArray, offset: Int, length: Int): Int
        /** 進行中の read をアンブロックする（stop または mute 時に呼ぶ）。以後の read は 0 を返せる */
        fun stopRead()
    }

    /** 再生の抽象（ブロッキング書き）。n ≥ 0: 書けたサンプル数。n < 0: エラー */
    interface Player {
        fun write(buf: ShortArray, offset: Int, length: Int): Int
        /** AudioTrack を pause してバッファを破棄する（flush は playing 中に呼んでも no-op なので pause 後に行う） */
        fun flush()
        fun stop()
    }

    // ---- 診断カウンター（累計。原子的に更新） ----

    data class Metrics(
        val captureReads: Long,
        val captureSamples: Long,
        val captureFramed: Long,
        val captureGated: Long,
        val captureSendAttempts: Long,
        val playSamples: Long,
        val playPartial: Long,
        val playErrors: Long,
    )

    private val cReads   = AtomicLong(0)
    private val cSamples = AtomicLong(0)
    private val cFramed  = AtomicLong(0)
    private val cGated   = AtomicLong(0)
    private val cSendAt  = AtomicLong(0)
    private val pSamples = AtomicLong(0)
    private val pPartial = AtomicLong(0)
    private val pErrors  = AtomicLong(0)

    fun metrics() = Metrics(
        cReads.get(), cSamples.get(), cFramed.get(), cGated.get(), cSendAt.get(),
        pSamples.get(), pPartial.get(), pErrors.get()
    )

    // ---- 状態 ----

    @Volatile var running = false
        private set
    @Volatile private var capture = true
    @Volatile private var micVolume = 1.0

    /** setCapture が呼ばれるたびに増加。n==0 受信時に途中フレームを破棄するかどうかの判断に使う */
    @Volatile private var captureEpoch = 0

    private val failedFlag = AtomicBoolean(false)
    private var stopped = false // captureLock の中でだけ触る。停止後に同じ pump を再開しない。
    private val captureLock = Object()
    private val gate = NativeSilenceGate()
    private var seq = 0L

    // ---- 公開操作 ----

    /** キャプチャの有効/無効を切り替える。mute 時は recorder.stopRead() でブロックを解除 */
    fun setCapture(enabled: Boolean) {
        capture = enabled
        captureEpoch++          // capture 変化を captureLoop に伝える（途中フレームの破棄判断）
        if (!enabled) recorder.stopRead()
        synchronized(captureLock) { captureLock.notifyAll() }
    }

    fun setMicVolume(v: Double) { micVolume = v }

    /**
     * stop() は running を即座に無効化し、Recorder のブロックを解除してから Player を止める。
     * キャプチャ・再生スレッドがそれぞれ自分のリソースを解放する（ここでは解放しない）。
     * Player.flush() は pause+flush を行い、バッファ済みの音を破棄する。
     */
    fun stop() {
        synchronized(captureLock) {
            if (stopped) return
            stopped = true
            running = false
            captureLock.notifyAll()
        }
        try { recorder.stopRead() } catch (_: Exception) {}
        try { player.flush() } catch (_: Exception) {}
        try { player.stop()  } catch (_: Exception) {}
    }

    // ---- ループ本体（NativeCallAudio のスレッドから呼ぶ） ----

    /**
     * キャプチャのループ本体。スレッドが終了する（running=false か fail）まで戻らない。
     * nowMs: 現在の時刻（ミリ秒）。SystemClock.elapsedRealtime() などを渡す。
     *
     * n==0 の処理（AudioRecord の stopped 状態/mute unblocked）:
     *   - captureEpoch が変わっていれば途中フレームを破棄（capture 変化によるデータ不整合を防ぐ）
     *   - epoch 変化なしなら部分フレームを保持（ドライバー quirk でのサンプル欠落を防ぐ）
     *   - 連続 0 が 3 回を超えたら 5ms のバックオフでビジーループを防ぐ
     *
     * n<0 の処理（AudioRecord ドライバーエラーコード）:
     *   - running && capture のときだけ fail（stop/mute 中の一過性エラーは無視）
     */
    fun captureLoop(nowMs: () -> Long) {
        val accum = ShortArray(NativePcm.FRAME)
        var accumulated = 0
        var localEpoch = captureEpoch
        var consecutiveZeros = 0
        try {
            while (running) {
                // ミュート/止まっている間は recorder.read を呼ばない
                synchronized(captureLock) {
                    while (running && !capture) captureLock.wait()
                }
                if (!running) break

                val remaining = NativePcm.FRAME - accumulated
                val n = recorder.read(accum, accumulated, remaining)

                when {
                    !running -> break
                    n == 0 -> {
                        // n=0: AudioRecord の stopped 状態/mute の stopRead() アンブロック
                        // → ドライバーエラーではないので fail しない
                        consecutiveZeros++
                        val currentEpoch = captureEpoch
                        if (currentEpoch != localEpoch) {
                            // capture が変わった → 途中フレームを破棄（状態境界をまたぐデータを送らない）
                            accumulated = 0
                            localEpoch = currentEpoch
                        }
                        // epoch 変化なし → 部分フレームを維持（ドライバー quirk でのサンプル欠落を防ぐ）
                        if (consecutiveZeros > 3) Thread.sleep(5)  // ビジーループ防止
                        continue
                    }
                    n < 0 -> {
                        // n<0: AudioRecord ドライバーエラーコード
                        consecutiveZeros = 0
                        if (!running || !capture) { accumulated = 0; continue }
                        fail("record_read")
                        break
                    }
                }

                consecutiveZeros = 0
                localEpoch = captureEpoch  // 成功した read のあとで epoch を揃える

                cReads.incrementAndGet()
                cSamples.addAndGet(n.toLong())
                accumulated += n
                if (accumulated < NativePcm.FRAME) continue   // 部分読み → 続けて溜める

                // 1 フレーム揃った
                cFramed.incrementAndGet()
                accumulated = 0

                // stop/mute 後のコールバック抑制（2 段チェック）
                if (!running || !capture) continue

                // マイク音量の適用（int16ToFloat の非対称を使う）
                val floats = NativePcm.int16ToFloat(accum)
                val vol = micVolume
                if (vol != 1.0) {
                    for (i in floats.indices) floats[i] = (floats[i] * vol).toFloat().coerceIn(-1f, 1f)
                }

                // 無音ゲート
                if (!gate.shouldSend(floats, nowMs())) {
                    cGated.incrementAndGet()
                    continue
                }

                // 最終確認 → 送信
                if (!running || !capture) continue
                val pcm = NativePcm.floatToInt16(floats)
                cSendAt.incrementAndGet()
                sender(seq++, NativeCallPump.shortsToLe(pcm))
            }
        } catch (_: InterruptedException) {
            // 正常終了（stop からの interrupt）
        } catch (_: Exception) {
            if (running) fail("record_error")
        }
        // リソース解放は呼び出し側（NativeCallAudio.captureLoop）が担う
    }

    /**
     * 再生のループ本体。スレッドが終了する（running=false か fail）まで戻らない。
     * 部分書き込みを繰り返し書く。ゼロ書き込みは 1ms スリープ。書き込みエラー 1 回で fail して返る。
     */
    fun playLoop(mixer: NativeMixer) {
        val out = ShortArray(NativePcm.FRAME)
        try {
            while (running) {
                mixer.mixBlock(out)
                var written = 0
                while (written < NativePcm.FRAME) {
                    if (!running) return
                    val n = player.write(out, written, NativePcm.FRAME - written)
                    when {
                        n < 0 -> {
                            pErrors.incrementAndGet()
                            if (running) fail("track_write")
                            return
                        }
                        n == 0 -> {
                            pPartial.incrementAndGet()
                            Thread.sleep(1)   // ドライバーが一時的に受け付けない → ビジーループしない
                        }
                        else -> {
                            pSamples.addAndGet(n.toLong())
                            if (n < NativePcm.FRAME - written) pPartial.incrementAndGet()
                            written += n
                        }
                    }
                }
            }
        } catch (_: InterruptedException) {
            // 正常終了
        } catch (_: Exception) {
            if (running) fail("track_error")
        }
        // リソース解放は呼び出し側（NativeCallAudio.playLoop）が担う
    }

    // ---- 内部 ----

    /**
     * 失敗を 1 回だけ報告する。running を即座に無効化（以後の sender 呼び出しを抑制）。
     * 両スレッドが同時に fail しても onFailure は 1 回だけ呼ばれる。
     */
    private fun fail(code: String) {
        if (failedFlag.compareAndSet(false, true)) {
            running = false
            synchronized(captureLock) { captureLock.notifyAll() }
            onFailure(code)
        }
    }

    /** ループ開始前に呼ぶ（重複 start を防ぐために NativeCallAudio が確認する） */
    fun markRunning() {
        synchronized(captureLock) {
            require(!running && !stopped) { "NativeCallPump: already started or stopped" }
            running = true
        }
    }

    companion object {
        /** 16 ビットの値を、リトルエンディアンの 2 バイトずつにする（NativeCallAudio に依存しない純粋関数） */
        fun shortsToLe(p: ShortArray): ByteArray {
            val b = ByteArray(p.size * 2)
            for (i in p.indices) {
                val s = p[i].toInt()
                b[2 * i]     = (s and 0xff).toByte()
                b[2 * i + 1] = ((s shr 8) and 0xff).toByte()
            }
            return b
        }
    }
}
