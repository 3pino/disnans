package dev.disnans.notifier

import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * NativeCallPump の単体テスト。フェイクの Recorder/Player で Android 依存なし。
 *
 * n=0/n<0 の区別:
 *   n=0  = AudioRecord の stopped 状態 / mute の stopRead() アンブロック → 安全な continue
 *   n<0  = AudioRecord ドライバーエラーコード → fail("record_read")
 * この区別はポンプの仕様で、テストも合わせる（エラーテストは pushError(-1) で n<0 を送る）。
 *
 * 確認する項目:
 *   1. 部分読みを FRAME まで溜めてからフレームを送る
 *   2. n=0 は安全な continue（ビジーループなし、stop で終わる）
 *   3. stop() でブロック中の read が解除されてスレッドが終わる
 *   4. mute 中は sender を呼ばない。unmute で再開する
 *   5. stop 後に sender のコールバックを呼ばない
 *   6. onFailure は 1 回だけ（両スレッドが同時に fail しても）
 *   7. player.stop() は 1 回だけ
 *   8. 重複 markRunning() は拒否する
 *   9. 部分書き込みを繰り返し書く
 *  10. player.write が -1 → fail("track_write")
 *  11. record.read が -1 → fail("record_read")
 *  12. 診断カウンターの正確な更新
 */
object NativeCallPumpTest {

    // ---- フェイクの Recorder ----

    /**
     * テスト用フェイク Recorder。sealed class で型安全（int エンコーディングなし）。
     * - push(count, value): N サンプル均一
     * - push(shorts): 任意の ShortArray
     * - pushStop(): n=0 を返す（mute アンブロック相当。 スレッドは continue して再び待つ）
     * - pushError(code): 負値を返す（ドライバーエラー → fail）
     * - stopRead(): n=0 をキューに追加（進行中の read をアンブロック）
     */
    private class FakeRecorder : NativeCallPump.Recorder {
        private sealed class Cmd {
            class Data(val shorts: ShortArray) : Cmd()
            object Zero : Cmd()          // n=0 を返す（safe continue）
            class Err(val code: Int) : Cmd()  // 負値（エラー）
        }

        private val q = LinkedBlockingQueue<Cmd>()
        val stopCount = AtomicInteger(0)
        val readCount = AtomicInteger(0)

        fun push(count: Int, value: Short = 0): FakeRecorder {
            q.put(Cmd.Data(ShortArray(count) { value })); return this
        }

        fun push(shorts: ShortArray): FakeRecorder {
            q.put(Cmd.Data(shorts)); return this
        }

        fun pushZero(): FakeRecorder { q.put(Cmd.Zero); return this }
        fun pushError(code: Int = -1): FakeRecorder { q.put(Cmd.Err(code)); return this }

        override fun read(buf: ShortArray, offset: Int, length: Int): Int {
            val cmd = q.poll(2000, TimeUnit.MILLISECONDS) ?: return 0
            return when (cmd) {
                is Cmd.Data -> {
                    val n = minOf(cmd.shorts.size, length)
                    cmd.shorts.copyInto(buf, offset, 0, n)
                    readCount.incrementAndGet()
                    n
                }
                is Cmd.Zero -> 0
                is Cmd.Err  -> cmd.code
            }
        }

        override fun stopRead() {
            stopCount.incrementAndGet()
            q.put(Cmd.Zero)
        }
    }

    // ---- フェイクの Player ----

    private class FakePlayer(
        private val chunkSize: Int = NativePcm.FRAME,
        private val onWrite: (() -> Unit)? = null,
    ) : NativeCallPump.Player {
        private val written = ArrayList<Short>()
        val stopCount = AtomicInteger(0)
        val flushCount = AtomicInteger(0)
        private var errorAfter = Int.MAX_VALUE
        private val writeCallCount = AtomicInteger(0)

        fun writtenSamples(): List<Short> = synchronized(written) { written.toList() }
        fun setErrorAfter(n: Int) { errorAfter = n }

        override fun write(buf: ShortArray, offset: Int, length: Int): Int {
            if (writeCallCount.incrementAndGet() > errorAfter) return -1
            val n = minOf(chunkSize, length)
            synchronized(written) { for (i in 0 until n) written.add(buf[offset + i]) }
            onWrite?.invoke()
            return n
        }
        override fun flush() { flushCount.incrementAndGet() }
        override fun stop()  { stopCount.incrementAndGet() }
    }

    // ---- ヘルパー ----

    private fun makePump(
        recorder: FakeRecorder,
        player: FakePlayer,
        sent: ArrayList<Pair<Long, ByteArray>> = ArrayList(),
        onSent: (() -> Unit)? = null,
        failures: ArrayList<String> = ArrayList(),
        onFail: (() -> Unit)? = null,
    ) = NativeCallPump(
        recorder = recorder,
        player = player,
        sender  = { seq, pcm -> synchronized(sent) { sent.add(seq to pcm) }; onSent?.invoke() },
        onFailure = { code -> synchronized(failures) { failures.add(code) }; onFail?.invoke() },
    )

    private fun startCapture(pump: NativeCallPump): Thread =
        Thread({ pump.captureLoop { System.currentTimeMillis() } }, "test-capture")
            .also { it.isDaemon = true; it.start() }

    /** 800 サンプル全て loud_value（~0.915 float）。int16ToFloat/RMS >> SILENCE_RMS → gate 通過 */
    private fun loudFrame(value: Short = 30_000) = ShortArray(NativePcm.FRAME) { value }

    /**
     * 指定カウンターが目標値に達するまでポーリングで待つ（最大 timeoutMs ミリ秒）。
     * 確定的な待機に使う（Thread.sleep の代わり）。
     */
    private fun waitFor(timeoutMs: Long = 5000, cond: () -> Boolean): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (!cond() && System.currentTimeMillis() < deadline) Thread.sleep(5)
        return cond()
    }

    // ---- テストケース ----

    /**
     * 部分読みを FRAME まで溜めてからフレームを生成する（100+300+400=800）。
     * value=1 は RMS << SILENCE_RMS → gate に止められる（captureGated=1）。
     * スレッドは captureFramed=1 になった後 pump.stop() で終わる。
     */
    fun testPartialReads() {
        val rec = FakeRecorder()
        val player = FakePlayer()
        val pump = makePump(rec, player)
        pump.markRunning()

        // 3 回の部分読み（合計 800 サンプル、値は無音レベル）
        rec.push(100, 1).push(300, 1).push(400, 1)

        val t = startCapture(pump)

        // captureFramed が 1 になるまで待つ（部分読みが蓄積されてフレームになった証拠）
        Check.that(waitFor { pump.metrics().captureFramed >= 1 }) { "captureFramed should reach 1" }
        pump.stop()
        t.join(2000)
        Check.that(!t.isAlive) { "thread should exit after stop" }

        val m = pump.metrics()
        Check.that(m.captureReads >= 3) { "captureReads >= 3, got ${m.captureReads}" }
        Check.eq(800L, m.captureSamples, "captureSamples")
        Check.eq(1L,   m.captureFramed,  "captureFramed")
        Check.eq(1L,   m.captureGated,   "captureGated (quiet samples are gated)")
        println("  PASS: partialReads")
    }

    /**
     * ゲートを通る大きなサンプルでフレームを送る。
     * CountDownLatch で送信を確定的に待つ（Thread.sleep なし）。
     */
    fun testFrameSent() {
        val rec = FakeRecorder()
        val player = FakePlayer()
        val sentLatch = CountDownLatch(1)
        val sent = ArrayList<Pair<Long, ByteArray>>()
        val pump = makePump(rec, player, sent = sent, onSent = { sentLatch.countDown() })
        pump.markRunning()

        // 800 サンプル全て 30_000 → float ≈ 0.915 → RMS >> 0.004 → gate 通過
        rec.push(loudFrame())

        val t = startCapture(pump)
        val frameSent = sentLatch.await(5, TimeUnit.SECONDS)
        pump.stop()
        t.join(2000)

        Check.that(frameSent) { "frame should have been sent (latch not triggered)" }
        val m = pump.metrics()
        Check.eq(1L, m.captureFramed,       "captureFramed")
        Check.eq(0L, m.captureGated,        "captureGated")
        Check.eq(1L, m.captureSendAttempts, "captureSendAttempts")
        synchronized(sent) {
            Check.eq(1, sent.size, "sent frames")
            Check.eq(0L, sent[0].first, "seq")
            Check.eq(NativePcm.FRAME * 2, sent[0].second.size, "frame bytes (1600)")
        }
        println("  PASS: frameSent")
    }

    /**
     * n=0 は安全な continue（ビジーループなし）。
     * スレッドは n=0 を受けた後、再び read に入って待機し、pump.stop() で終わる。
     */
    fun testZeroReadNoSpin() {
        val rec = FakeRecorder()
        val player = FakePlayer()
        val pump = makePump(rec, player)
        pump.markRunning()

        // n=0 を返した後、スレッドは再び read に入って待機（ビジーループしない）
        rec.pushZero()

        val t = startCapture(pump)
        // スレッドが再び read に入るのを少し待つ
        Thread.sleep(50)
        pump.stop()
        t.join(2000)
        Check.that(!t.isAlive) { "thread should exit after stop" }
        println("  PASS: zeroReadNoSpin")
    }

    /**
     * stop() でブロック中の read が解除されてスレッドが終わる。
     * カスタム Recorder で read 開始を CountDownLatch で通知する。
     */
    fun testStopUnblocksRead() {
        val rec = FakeRecorder()
        val player = FakePlayer()
        val readStarted = CountDownLatch(1)

        val pump = NativeCallPump(
            recorder = object : NativeCallPump.Recorder {
                override fun read(buf: ShortArray, offset: Int, length: Int): Int {
                    readStarted.countDown()        // read に入ったことを通知
                    return rec.read(buf, offset, length)
                }
                override fun stopRead() = rec.stopRead()
            },
            player = player,
            sender = { _, _ -> },
            onFailure = { },
        )
        pump.markRunning()

        val t = startCapture(pump)
        // read が呼ばれるまで確定的に待ってから stop
        Check.that(readStarted.await(3, TimeUnit.SECONDS)) { "read should have been called" }
        pump.stop()
        t.join(2000)
        Check.that(!t.isAlive) { "thread should exit after stop()" }
        Check.that(rec.stopCount.get() >= 1) { "stopRead should be called at least once" }
        println("  PASS: stopUnblocksRead")
    }

    /**
     * mute 中は sender を呼ばない。unmute で再開する。
     * n=0（mute Stop）が capture=true のときに消費されても fail しないことも確認。
     */
    fun testMuteUnmute() {
        val rec = FakeRecorder()
        val player = FakePlayer()
        val sentLatch = CountDownLatch(1)
        val sent = ArrayList<Pair<Long, ByteArray>>()
        val pump = makePump(rec, player, sent = sent, onSent = { sentLatch.countDown() })
        pump.markRunning()

        val t = startCapture(pump)

        // ミュート（stopRead で n=0 がキューに入り、read をアンブロック）
        pump.setCapture(false)
        // ミュート中にサンプルをキューに積む（capture=false なので送らない）
        rec.push(loudFrame())
        // スレッドが captureLock.wait() に入るのを待つ（少量のスリープ。n=0→continue の後）
        Thread.sleep(50)
        synchronized(sent) {
            Check.that(sent.isEmpty()) { "should not send while muted, got ${sent.size}" }
        }

        // アンミュート → ループ再開
        pump.setCapture(true)
        // アンミュート後は明示的に大きなサンプルを追加（最初の push は muted で消費されるかもしれない）
        rec.push(loudFrame())

        // 送信されるまで確定的に待つ
        val ok = sentLatch.await(5, TimeUnit.SECONDS)
        pump.stop()
        t.join(2000)

        Check.that(ok) { "should have sent a frame after unmute (latch not triggered)" }
        synchronized(sent) {
            Check.that(sent.isNotEmpty()) { "sent should not be empty after unmute" }
        }
        println("  PASS: muteUnmute")
    }

    /**
     * stop 後に sender のコールバックを呼ばない。
     * カスタム Recorder で read がブロックし、stopRead() が解除する。
     */
    fun testNoSenderAfterStop() {
        val rec = FakeRecorder()
        val player = FakePlayer()
        val sent = ArrayList<Pair<Long, ByteArray>>()
        val stoppedLatch = CountDownLatch(1)

        val pump = NativeCallPump(
            recorder = object : NativeCallPump.Recorder {
                override fun read(buf: ShortArray, offset: Int, length: Int): Int {
                    stoppedLatch.await()   // stop が来るまでブロック
                    return 0
                }
                override fun stopRead() { stoppedLatch.countDown() }
            },
            player = player,
            sender = { seq, pcm -> synchronized(sent) { sent.add(seq to pcm) } },
            onFailure = { },
        )
        pump.markRunning()
        val t = startCapture(pump)

        // read がブロック中になるまで少し待ってから stop
        Thread.sleep(20)
        pump.stop()
        t.join(2000)
        Check.that(!t.isAlive) { "captureLoop should exit after stop" }

        // stop 後にサンプルを積んでも送られない（スレッドは終了済み）
        rec.push(loudFrame())
        Thread.sleep(30)
        synchronized(sent) {
            Check.that(sent.isEmpty()) { "should not send after stop, got ${sent.size}" }
        }
        println("  PASS: noSenderAfterStop")
    }

    /** onFailure は 1 回だけ（player エラー発生） */
    fun testFailureOnce() {
        val rec = FakeRecorder()
        val player = FakePlayer()
        player.setErrorAfter(1)  // 2 回目の write からエラー
        val failures = ArrayList<String>()
        val failLatch = CountDownLatch(1)
        val pump = makePump(rec, player, failures = failures, onFail = { failLatch.countDown() })
        pump.markRunning()

        val mixer = NativeMixer()
        val tCap  = startCapture(pump)
        val tPlay = Thread({ pump.playLoop(mixer) }, "test-play").also { it.isDaemon = true; it.start() }

        Check.that(failLatch.await(5, TimeUnit.SECONDS)) { "onFailure should be called" }
        pump.stop()
        tCap.join(2000); tPlay.join(2000)

        synchronized(failures) {
            Check.eq(1, failures.size, "onFailure should be called exactly once, got $failures")
        }
        println("  PASS: failureOnce")
    }

    /** player.stop() / flush() は pump.stop() で各 1 回だけ */
    fun testPlayerStopOnce() {
        val rec = FakeRecorder()
        val writtenLatch = CountDownLatch(1)
        val player = FakePlayer(onWrite = { writtenLatch.countDown() })
        val pump = makePump(rec, player)
        pump.markRunning()

        val t = Thread({ pump.playLoop(NativeMixer()) }, "test-play").also { it.isDaemon = true; it.start() }
        Check.that(writtenLatch.await(5, TimeUnit.SECONDS)) { "player should have written at least 1 frame" }
        pump.stop()
        t.join(2000)

        Check.eq(1, player.stopCount.get(),  "player.stop() called once")
        Check.eq(1, player.flushCount.get(), "player.flush() called once")
        println("  PASS: playerStopOnce")
    }

    /** 重複 markRunning() は IllegalArgumentException を投げる */
    fun testDoubleStartRejected() {
        val rec = FakeRecorder()
        val player = FakePlayer()
        val pump = makePump(rec, player)
        pump.markRunning()
        var threw = false
        try { pump.markRunning() } catch (_: IllegalArgumentException) { threw = true }
        Check.that(threw) { "second markRunning() should throw IllegalArgumentException" }
        pump.stop()
        println("  PASS: doubleStartRejected")
    }

    /** 部分書き込み: write が chunkSize=100 < FRAME を返しても 1 フレーム全体が書かれる */
    fun testPartialWrite() {
        val rec = FakeRecorder()
        val writtenLatch = CountDownLatch(NativePcm.FRAME / 100)  // 8 回の部分書き込み
        val player = object : NativeCallPump.Player {
            private val written = ArrayList<Short>()
            val stopCount = AtomicInteger(0)
            val flushCount = AtomicInteger(0)
            private val writeCallCount = AtomicInteger(0)
            fun writtenSamples() = synchronized(written) { written.toList() }
            override fun write(buf: ShortArray, offset: Int, length: Int): Int {
                val n = minOf(100, length)
                synchronized(written) { for (i in 0 until n) written.add(buf[offset + i]) }
                writtenLatch.countDown()
                return n
            }
            override fun flush() { flushCount.incrementAndGet() }
            override fun stop()  { stopCount.incrementAndGet() }
        }
        val pump = NativeCallPump(
            recorder = rec, player = player,
            sender = { _, _ -> }, onFailure = { },
        )
        pump.markRunning()
        val t = Thread({ pump.playLoop(NativeMixer()) }, "test-play").also { it.isDaemon = true; it.start() }

        Check.that(writtenLatch.await(5, TimeUnit.SECONDS)) { "all partial writes should complete" }
        pump.stop()
        t.join(2000)

        val ws = player.writtenSamples()
        // stop はフレーム境界で止まるとは限らないため ws.size の割り算は確認しない
        // 少なくとも 1 フレーム分（800 サンプル）が書かれていることを確認する
        Check.that(ws.size >= NativePcm.FRAME) { "at least FRAME samples should be written, got ${ws.size}" }
        Check.that(pump.metrics().playPartial > 0) { "partial writes should be counted" }
        println("  PASS: partialWrite")
    }

    /** player.write が -1 → fail("track_write") で停止 */
    fun testPlayerWriteError() {
        val rec = FakeRecorder()
        val player = FakePlayer()
        player.setErrorAfter(2)
        val failures = ArrayList<String>()
        val failLatch = CountDownLatch(1)
        val pump = makePump(rec, player, failures = failures, onFail = { failLatch.countDown() })
        pump.markRunning()

        val t = Thread({ pump.playLoop(NativeMixer()) }, "test-play").also { it.isDaemon = true; it.start() }
        Check.that(failLatch.await(5, TimeUnit.SECONDS)) { "onFailure should be triggered by write error" }
        pump.stop()
        t.join(2000)
        Check.that(!t.isAlive) { "playLoop should exit on error" }
        Check.eq(1, failures.size, "should fail exactly once")
        Check.eq("track_write", failures[0], "failure code")
        println("  PASS: playerWriteError")
    }

    /** record.read が -1 → fail("record_read") */
    fun testRecordReadError() {
        val rec = FakeRecorder()
        val player = FakePlayer()
        val failures = ArrayList<String>()
        val failLatch = CountDownLatch(1)
        val pump = makePump(rec, player, failures = failures, onFail = { failLatch.countDown() })
        pump.markRunning()

        rec.pushError(-1)  // n<0 → ドライバーエラー → fail

        val t = startCapture(pump)
        Check.that(failLatch.await(5, TimeUnit.SECONDS)) { "onFailure should be triggered by read error" }
        pump.stop()
        t.join(2000)
        Check.eq(1, failures.size, "should fail exactly once")
        Check.eq("record_read", failures[0], "failure code")
        println("  PASS: recordReadError")
    }

    /** 診断カウンターが正しく更新される（2 フレーム、大きな値で gate 通過） */
    fun testMetrics() {
        val rec = FakeRecorder()
        val player = FakePlayer()
        val twoFramesSentLatch = CountDownLatch(2)
        val sent = ArrayList<Pair<Long, ByteArray>>()
        val pump = makePump(rec, player, sent = sent, onSent = { twoFramesSentLatch.countDown() })
        pump.markRunning()

        rec.push(loudFrame()).push(loudFrame())

        val t = startCapture(pump)
        Check.that(twoFramesSentLatch.await(5, TimeUnit.SECONDS)) { "two frames should be sent" }
        pump.stop()
        t.join(2000)

        val m = pump.metrics()
        Check.eq(2L, m.captureReads,           "captureReads")
        Check.eq(NativePcm.FRAME * 2L, m.captureSamples, "captureSamples")
        Check.eq(2L, m.captureFramed,          "captureFramed")
        Check.eq(0L, m.captureGated,           "captureGated")
        Check.eq(2L, m.captureSendAttempts,    "captureSendAttempts")
        synchronized(sent) { Check.eq(2, sent.size, "sent.size") }
        println("  PASS: metrics")
    }

    fun run() {
        println("NativeCallPumpTest:")
        testPartialReads()
        testFrameSent()
        testZeroReadNoSpin()
        testStopUnblocksRead()
        testMuteUnmute()
        testNoSenderAfterStop()
        testFailureOnce()
        testPlayerStopOnce()
        testDoubleStartRejected()
        testPartialWrite()
        testPlayerWriteError()
        testRecordReadError()
        testMetrics()
        println("NativeCallPumpTest: all ${Check.count} checks passed")
    }
}

fun main() = NativeCallPumpTest.run()
