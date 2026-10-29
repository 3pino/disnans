package dev.disnans.notifier

import okio.ByteString
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sqrt

/**
 * 通話の音声の純粋な処理（Android に依存しない）。web 版の `app/src/lib/call/pure.ts` と同じ決まり。
 * 形式: 16kHz・モノラル・PCM16（リトルエンディアン）。送る 1 フレームは 800 サンプル（50ms）。
 * 照合: `src/test/resources/native-call/golden-v1.json`（pure.ts の出力から作った固定の値）。
 * 同じでない点（ネイティブ固有）: 送信の前処理（エコー消去・雑音抑制・自動音量）はデバイスの標準の効果で、
 * ブラウザーの WebRTC の処理とは別物。ここでは数式だけを合わせる。
 */
object NativePcm {
  const val RATE = 16000
  const val FRAME = 800
  const val FRAME_SEC = FRAME.toDouble() / RATE

  /** 受け取った音を鳴らし始めるまでの先読み（秒）と、これ以上たまったら捨てる長さ（秒） */
  const val LEAD_SEC = 0.12
  const val MAX_LEAD_SEC = 0.6

  /** 無音を送らない: この RMS 以下が HOLD_MS 続いたら送らない（しゃべり終わりの 500ms は送り続ける） */
  const val SILENCE_RMS = 0.004
  const val HOLD_MS = 500L

  const val LIMIT_DB_MIN = -18.0
  const val LIMIT_DB_MAX = -3.0
  const val LIMIT_DB_DEFAULT = -6.0
  const val LIMIT_LOOKAHEAD_MS = 5
  const val LIMIT_ATTACK_MS = 3
  const val LIMIT_RELEASE_MS = 150

  const val MIC_VOLUME_MAX = 2.0
  const val OUT_VOLUME_MAX = 1.0

  /** 上限（dBFS）。数でない・無限大は既定値（pure.ts の clampLimitDb） */
  fun clampLimitDb(v: Double?): Double {
    if (v == null || !v.isFinite()) return LIMIT_DB_DEFAULT
    return min(LIMIT_DB_MAX, max(LIMIT_DB_MIN, v))
  }

  fun dbToLinear(db: Double): Double = 10.0.pow(db / 20.0)

  /** 音量の値（0 以上・上限まで。数でなければ 1）*/
  fun clampVolume(v: Double?, max: Double): Double {
    if (v == null || !v.isFinite()) return 1.0
    return min(max, max(0.0, v))
  }

  /** Float（-1〜1）を PCM16 に。負と正で倍率が違う（pure.ts の floatToInt16 と同じ切り捨て） */
  fun floatToInt16(f: FloatArray): ShortArray {
    val out = ShortArray(f.size)
    for (i in f.indices) {
      val v = min(1.0, max(-1.0, f[i].toDouble()))
      out[i] = (if (v < 0) v * 0x8000 else v * 0x7fff).toInt().toShort()
    }
    return out
  }

  fun int16ToFloat(p: ShortArray): FloatArray {
    val out = FloatArray(p.size)
    for (i in p.indices) {
      val s = p[i].toInt()
      out[i] = (s.toDouble() / (if (s < 0) 0x8000 else 0x7fff)).toFloat()
    }
    return out
  }

  /** PCM16（LE）を標準の base64（パディングつき）に。1 フレームは 2136 文字 */
  fun pcmToBase64(p: ShortArray): String {
    val b = ByteArray(p.size * 2)
    for (i in p.indices) {
      val s = p[i].toInt()
      b[2 * i] = (s and 0xff).toByte()
      b[2 * i + 1] = ((s shr 8) and 0xff).toByte()
    }
    return ByteString.of(*b).base64()
  }

  /**
   * 受け取った base64 を PCM16 に。壊れた入力・長さが合わないものは null（pure.ts の base64ToPcm と同じ）。
   * atob と同じく、ASCII の空白は無視し、パディングの無い入力も受ける。
   */
  fun base64ToPcm(b64: String?): ShortArray? {
    // 検証と復号は NativeCallProtocol.decodePcm の一箇所だけ（atob の規則と同じ）
    val bytes = NativeCallProtocol.decodePcm(b64) ?: return null
    return leToShorts(bytes)
  }

  /** 16 ビットの値を、リトルエンディアンの 2 バイトずつにする */
  fun shortsToLe(p: ShortArray): ByteArray {
    val b = ByteArray(p.size * 2)
    for (i in p.indices) {
      val v = p[i].toInt()
      b[2 * i] = (v and 0xff).toByte()
      b[2 * i + 1] = ((v shr 8) and 0xff).toByte()
    }
    return b
  }

  /** リトルエンディアンの 2 バイトずつを 16 ビットの値に（偶数のバイト数の分だけ） */
  fun leToShorts(b: ByteArray): ShortArray {
    val out = ShortArray(b.size / 2)
    for (i in out.indices) out[i] = ((b[2 * i].toInt() and 0xff) or (b[2 * i + 1].toInt() shl 8)).toShort()
    return out
  }

  fun rms(f: FloatArray): Double {
    if (f.isEmpty()) return 0.0
    var sum = 0.0
    for (v in f) sum += v.toDouble() * v
    return sqrt(sum / f.size)
  }
}

/**
 * 相手 1 人分の上限（先読みつきのピーク制限）。pure.ts の PeakLimiter と同じ式。
 * 1 フレームずつ、受け取った順に通す（状態をまたぐ）。出力は必ず上限以下になる。
 */
class NativePeakLimiter(sampleRate: Int = NativePcm.RATE, ceilingDb: Double = NativePcm.LIMIT_DB_DEFAULT) {
  private val lookahead = max(1, Math.round(NativePcm.LIMIT_LOOKAHEAD_MS * sampleRate / 1000.0).toInt())
  private val attackStep = 1.0 / max(1.0, NativePcm.LIMIT_ATTACK_MS * sampleRate / 1000.0)
  private val releaseCoef = exp(-1.0 / max(1.0, NativePcm.LIMIT_RELEASE_MS * sampleRate / 1000.0))
  private var ceiling = NativePcm.dbToLinear(NativePcm.clampLimitDb(ceilingDb))
  private var gain = 1.0
  private var xs = FloatArray(lookahead)
  private var gs = FloatArray(lookahead) { 1f }

  fun setCeilingDb(db: Double) {
    ceiling = NativePcm.dbToLinear(NativePcm.clampLimitDb(db))
  }

  /** 入れた音と同じ長さの音を返す（先読みの分だけ遅れる）。続けて渡すこと */
  fun process(input: FloatArray): FloatArray {
    val l = lookahead
    val n = input.size
    val m = l + n
    val x = FloatArray(m)
    xs.copyInto(x, 0)
    input.copyInto(x, l)
    val req = FloatArray(m)
    gs.copyInto(req, 0)
    for (i in l until m) {
      val a = abs(x[i].toDouble())
      req[i] = (if (a > ceiling) ceiling / a else 1.0).toFloat()
    }
    val out = FloatArray(n)
    // 単調キューで、いまのサンプルから先 L 個の中の最小（守るべき最も小さいゲイン）を求める
    val dq = IntArray(m)
    var head = 0
    var tail = 0
    for (j in 0 until m) {
      while (tail > head && req[dq[tail - 1]].toDouble() >= req[j].toDouble()) tail--
      dq[tail++] = j
      while (dq[head] < j - l) head++
      if (j < l) continue
      val i = j - l
      val target = req[dq[head]].toDouble()
      gain = if (target < gain) max(target, gain - attackStep) else target + (gain - target) * releaseCoef
      val y = x[i] * gain
      out[i] = (if (y > ceiling) ceiling else if (y < -ceiling) -ceiling else y).toFloat()
    }
    xs = x.copyOfRange(n, m)
    gs = req.copyOfRange(n, m)
    return out
  }
}

/**
 * 受け取った塊をいつ鳴らすか（ジッター）。pure.ts の scheduleFrame と同じ式。
 * st.next は次に鳴らす時刻（秒）。遅れて空になったら lead だけためてから鳴らし直し、先に溜まりすぎたら捨てる（null）。
 */
class NativeJitterSchedule(private val lead: Double = NativePcm.LEAD_SEC, private val maxLead: Double = NativePcm.MAX_LEAD_SEC) {
  var next = 0.0
    private set

  fun schedule(now: Double, dur: Double): Double? {
    if (next < now + 0.02) next = now + lead
    else if (next - now > maxLead) return null
    val at = next
    next += dur
    return at
  }

  fun reset() {
    next = 0.0
  }
}

/** 送る前の無音の判定（pure.ts の store の sendFrame と同じ）。送るなら true */
class NativeSilenceGate {
  private var loudAt = 0L

  fun shouldSend(frame: FloatArray, nowMs: Long): Boolean {
    if (NativePcm.rms(frame) > NativePcm.SILENCE_RMS) {
      loudAt = nowMs
      return true
    }
    return nowMs - loudAt <= NativePcm.HOLD_MS
  }

  fun reset() {
    loudAt = 0L
  }
}

/**
 * 相手の音を 1 本にまとめる（再生の並べ方）。web 版は WebAudio に一つずつ予約するが、ここでは
 * 16kHz のサンプルの時間軸に書き込み、再生の 1 ブロック（800 サンプル）ごとに足し合わせる。
 * 時刻は「次に書くブロックの先頭のサンプル」（writer の時計）。受けた塊は scheduleFrame と同じ式で置く。
 * 同期は呼び出し側の synchronized（受信と再生の両スレッドから使う）。
 */
class NativeMixer(private val ringSamples: Int = 2 * NativePcm.RATE) {
  private class Peer(ringSize: Int) {
    val schedule = NativeJitterSchedule()
    var limiter: NativePeakLimiter? = null
    val ring = FloatArray(ringSize)
    var gain = 1.0
  }

  private val peers = HashMap<String, Peer>()
  /** 上限（dBFS）。null なら上限の段を通さない（pure.ts の limiter オフ） */
  private var limitDb: Double? = null
  /** 再生の位置（サンプル。単調に増える） */
  var playPos: Long = 0L
    private set

  /** EMPTY: 空の塊。TOO_LONG: リングに収まらない長さ（捨てる） */
  enum class Accept { ACCEPTED, LATE, UNKNOWN_PEER, EMPTY, TOO_LONG }

  @Synchronized fun nowSec(): Double = playPos.toDouble() / NativePcm.RATE

  @Synchronized fun addPeer(peer: String) {
    peers.getOrPut(peer) { Peer(ringSamples) }
  }

  @Synchronized fun removePeer(peer: String) {
    peers.remove(peer)
  }

  @Synchronized fun peerCount(): Int = peers.size

  @Synchronized fun clear() {
    peers.clear()
  }

  @Synchronized fun setGain(peer: String, gain: Double) {
    peers[peer]?.gain = gain
  }

  /** 上限を変える。切ったら、相手ごとの上限の状態も捨てる（入れ直したときに古い先読みを鳴らさない） */
  @Synchronized fun setLimit(db: Double?) {
    limitDb = db?.let { NativePcm.clampLimitDb(it) }
    if (limitDb == null) for (p in peers.values) p.limiter = null
  }

  /** 受けた 1 塊（800 サンプル）。上限を通して、置く場所を決める */
  @Synchronized fun accept(peer: String, pcm: ShortArray): Accept {
    val p = peers[peer] ?: return Accept.UNKNOWN_PEER
    if (pcm.isEmpty()) return Accept.EMPTY
    // 長さは実際のサンプル数で決める（800 以外の塊も、その長さの時間だけ進める）
    if (pcm.size > ringSamples / 2) return Accept.TOO_LONG
    var samples = NativePcm.int16ToFloat(pcm)
    val db = limitDb
    if (db != null) {
      val lim = p.limiter ?: NativePeakLimiter(NativePcm.RATE, db).also { p.limiter = it }
      lim.setCeilingDb(db)
      samples = lim.process(samples)
    } else {
      p.limiter = null
    }
    val dur = pcm.size.toDouble() / NativePcm.RATE
    val at = p.schedule.schedule(nowSec(), dur) ?: return Accept.LATE
    val start = Math.round(at * NativePcm.RATE)
    if (start < playPos) return Accept.LATE
    for (i in samples.indices) p.ring[((start + i) % ringSamples).toInt()] = samples[i]
    return Accept.ACCEPTED
  }

  /** 次の 800 サンプルを足し合わせて、PCM16 にする。再生のスレッドが 50ms ごとに呼ぶ */
  @Synchronized fun mixBlock(out: ShortArray) {
    require(out.size == NativePcm.FRAME)
    val sum = FloatArray(NativePcm.FRAME)
    for (p in peers.values) {
      for (i in 0 until NativePcm.FRAME) {
        val idx = ((playPos + i) % ringSamples).toInt()
        val v = p.ring[idx]
        p.ring[idx] = 0f
        sum[i] += (v * p.gain).toFloat()
      }
    }
    val db = limitDb
    if (db != null) {
      val c = NativePcm.dbToLinear(NativePcm.clampLimitDb(db)).toFloat()
      for (i in sum.indices) sum[i] = sum[i].coerceIn(-c, c)
    }
    val pcm = NativePcm.floatToInt16(sum)
    pcm.copyInto(out)
    playPos += NativePcm.FRAME
  }
}

/**
 * 録音の短い読み取りを、1 フレーム（800 サンプル）にそろえる。足りない分は次の読みと合わせる（捨てない）。
 * 戻り値は、今回の読みでそろったフレームの列（それぞれ新しい配列）。
 */
class NativeFrameAccumulator(private val frame: Int = NativePcm.FRAME) {
  private val buf = ShortArray(frame)
  private var n = 0

  fun feed(src: ShortArray, count: Int): List<ShortArray> {
    val out = ArrayList<ShortArray>()
    var off = 0
    val end = minOf(count, src.size)
    while (off < end) {
      val take = minOf(frame - n, end - off)
      System.arraycopy(src, off, buf, n, take)
      n += take
      off += take
      if (n == frame) {
        out.add(buf.copyOf())
        n = 0
      }
    }
    return out
  }

  /** 途中のフレームを捨てる（開始し直すとき） */
  fun reset() {
    n = 0
  }
}

/** 再生の書き込みの結果 */
sealed class PumpResult {
  object Written : PumpResult()
  object Stopped : PumpResult()
  data class Failed(val code: Int) : PumpResult()
}

/**
 * 再生へ 1 塊（buf）を書き切る。短い書き込みは続きから書く。書き込みが 0 のときは少し待つ（空回りしない）。
 * 負の値は失敗。止められたら、残りは書かずに戻る。`write` は AudioTrack.write の形（配列・位置・長さ）。
 */
object NativePump {
  const val IDLE_WAIT_MS = 5L

  fun writeAll(
    buf: ShortArray,
    write: (ShortArray, Int, Int) -> Int,
    running: () -> Boolean,
    sleepMs: (Long) -> Unit,
  ): PumpResult {
    var off = 0
    while (off < buf.size) {
      if (!running()) return PumpResult.Stopped
      val n = write(buf, off, buf.size - off)
      when {
        n < 0 -> return PumpResult.Failed(n)
        n == 0 -> sleepMs(IDLE_WAIT_MS)
        else -> off += n
      }
    }
    return PumpResult.Written
  }
}
