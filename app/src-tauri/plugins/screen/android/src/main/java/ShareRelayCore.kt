package dev.disnans.screen

import kotlin.math.max
import kotlin.math.min

/*
 * 画面の中継（ネイティブ）の純粋な部分。Android の型も、通話の実物も使わない。
 * 数値と形は SDK の契約と、受け手（examples/screenshare/main.js の FrameAssembler / parseChunk）に合わせる。
 * 1 本のスレッド（中継の実行）から呼ぶ前提。時刻は呼び出し側が渡す（テストで進める）。
 */

object RelayLimits {
  /** 1 かけらの上限（base64 の文字数）。音声の送信の余裕を残すため小さめ */
  const val CHUNK_CHARS = 8 * 1024
  /** 受け手が受け取るかけらの数の上限（main.js MAX_CHUNKS） */
  const val MAX_CHUNKS = 64
  /** 1 フレームの上限（base64 の文字数）。これを超えたら捨てて、画質を下げるよう頼む */
  const val MAX_FRAME_CHARS = CHUNK_CHARS * MAX_CHUNKS
  /** 送る前に、まだ送信待ちのバイトがこれ以下であること（ライブの値で判断する） */
  const val QUEUE_LIMIT_BYTES = 8L * 1024
  const val HEARTBEAT_MS = 3000L
  const val KEEPALIVE_MS = 5000L
  const val RETRY_MS = 30L
  /** 通話が一覧に居ない（回復中など）あいだ、状態を見直す間隔 */
  const val PAUSED_POLL_MS = 1000L
  /** 途中のフレームを、この時間を過ぎたら捨てる（新しいフレームに替える） */
  const val EXPIRY_MS = 2000L
  /** 画質を下げるよう頼むのは、この間隔より速くはしない */
  const val OVERSIZE_GAP_MS = 2000L
  /** main.js の SERVER_BUDGET_KBPS と同じ */
  const val BUDGET_KBPS = 2400.0
  /** main.js の MAX_DELAY_MS と同じ */
  const val MAX_DELAY_MS = 5000L
  /** main.js の MIN_QUALITY / MIN_SCALE と同じ */
  const val MIN_QUALITY = 0.35
  const val MIN_SCALE = 0.4
  const val NAME_MAX_CHARS = 64
  /** 追加状態の JSON 全体（{} を含む）の上限（UTF-8 のバイト） */
  const val STATE_EXTRA_MAX_BYTES = 256
}

/** 送る側と受け手の間の、通話の結び（session と generation）。ID は表示しない */
data class RelayBinding(
  val session: String,
  val generation: Long,
  val joined: Boolean,
  val listed: Boolean,
  val wanted: Boolean,
) {
  /** 送ってよい状態（参加中で、一覧にあり、待っている） */
  val active: Boolean get() = wanted && joined && listed
}

data class RelayEmit(val ok: Boolean, val code: String? = null)

/**
 * 通話の読み取り。Unavailable は「読めなかった」（通話が終わったとは限らない）。NoCall は、読めて通話が無いと確かめたとき。
 */
sealed class BindingRead {
  object Unavailable : BindingRead()
  object NoCall : BindingRead()
  class Call(val binding: RelayBinding) : BindingRead()
}

/** 受け手に見せる f の番号。プロセス全体で増え続けること（撮りをまたいでも戻さない） */
interface FrameIdSource {
  fun next(): Long
}

/** 時計の値から始まる、増えていくだけの番号（JS の安全な整数の内に収まる） */
class FrameIdAllocator(seed: Long, private val clock: () -> Long = { seed }) : FrameIdSource {
  private val last = java.util.concurrent.atomic.AtomicLong(seed)
  override fun next(): Long {
    while (true) {
      val before = last.get()
      val next = max(before + 1, clock())
      if (last.compareAndSet(before, next)) return next
    }
  }
}

/** 中継が使う窓口（実物は ShareRelayHost。テストでは偽物）。UI のコールバックは呼ばない */
interface RelayPort {
  /** 通話の読み取り（読むだけ） */
  fun binding(): BindingRead
  /** 世代つきの送信（Host が世代を実行の中で確かめる）。name は frame か state のどちらか */
  fun emit(b: RelayBinding, name: String, payloadJson: String): RelayEmit
  /** 送信待ちのバイト数。読めないときは null（送らずに待つ。0 とは扱わない） */
  fun queuedBytes(): Long?
  /** 1 フレームが大きすぎた。画質を下げてよいと知らせる（上限は呼び出し側で守る） */
  fun onOversize()
  /** 中継が終わった（同じ code を 1 回だけ） */
  fun onEnded(code: String)
}

/** 固定の名前だけを数える（ID やペイロードは入れない） */
enum class RelayCount(val wire: String) {
  PRODUCED("produced"),
  ENQUEUED("enqueued"),
  SENT_CHUNKS("sent_chunks"),
  SENT_FRAMES("sent_frames"),
  DROPPED_REPLACED("dropped_replaced"),
  DROPPED_OVERSIZE("dropped_oversize"),
  DROPPED_INVALID("dropped_invalid"),
  DROPPED_EXPIRED("dropped_expired"),
  DROPPED_REFUSED("dropped_refused"),
  DROPPED_PAUSED("dropped_paused"),
  STATE_SENT("state_sent"),
  KEEPALIVE("keepalive"),
  QUERY("query"),
  MEMBER_ANNOUNCE("member_announce"),
  PAUSED("paused"),
  QUEUE_WAIT("queue_wait"),
  EMIT_REFUSED("emit_refused"),
  BINDING_UNAVAILABLE("binding_unavailable"),
  QUEUE_UNKNOWN("queue_unknown"),
}

class RelayCounters {
  private val values = LongArray(RelayCount.values().size)

  fun inc(c: RelayCount) {
    values[c.ordinal]++
  }

  fun get(c: RelayCount): Long = values[c.ordinal]

  /** 固定の順で「名前=数」を並べる（ログ用） */
  fun line(): String = RelayCount.values().joinToString(" ") { "${it.wire}=${values[it.ordinal]}" }
}

sealed class Verdict {
  object Active : Verdict()
  object Paused : Verdict()
  /** 読めなかった。通話の終わりとは扱わない（送らずに待つ） */
  object Unavailable : Verdict()
  class Ended(val code: String) : Verdict()
}

/** 中継の判断（純粋）。通話の状態がどう変わったかで、続ける・待つ・終わる を決める */
object RelayPolicy {
  /** 読めて通話があるときの、その通話 */
  fun callOf(r: BindingRead): RelayBinding? = (r as? BindingRead.Call)?.binding

  /** 始めてよい（参加中・一覧・待っている）か */
  fun startable(now: RelayBinding?): Boolean = now != null && now.active

  /** 許可のあとの確かめ。始めたときと同じ通話（session と generation）で、いまも送ってよいこと */
  fun revalidate(pending: RelayBinding, r: BindingRead): Boolean {
    val now = callOf(r) ?: return false
    return now.session == pending.session && now.generation == pending.generation && now.active
  }

  /** 送っている通話の、いまの状態。終わりは、通話が無いと確かめたとき（NoCall）か、別の通話になったときだけ */
  fun classify(bound: RelayBinding, r: BindingRead): Verdict = when (r) {
    BindingRead.Unavailable -> Verdict.Unavailable
    BindingRead.NoCall -> Verdict.Ended("call_ended")
    is BindingRead.Call -> {
      val now = r.binding
      when {
        now.session != bound.session || now.generation != bound.generation -> Verdict.Ended("call_changed")
        !now.wanted -> Verdict.Ended("call_stopped")
        !(now.joined && now.listed) -> Verdict.Paused
        else -> Verdict.Active
      }
    }
  }

  /** ネイティブ中継は JS を動かし続けない。従来の取得か小窓だけが再開を必要とする。 */
  fun keepWebViewActive(inPip: Boolean, capturing: Boolean, nativeRelay: Boolean): Boolean =
    inPip || (capturing && !nativeRelay)

  /** 画面（JS の表示）に見せてよい状態か。前面、または小窓 */
  fun previewVisible(resumed: Boolean, inPip: Boolean): Boolean = resumed || inPip

  /** JS へ途中の画像を渡してよいか。中継のときは、見えているときだけ */
  fun deliverPreview(relayOn: Boolean, previewVisible: Boolean): Boolean = !relayOn || previewVisible
}

/** 間隔と画質の計算（main.js の nextInterval / tuneQuality と同じ式） */
object RelayPacing {
  fun intervalMs(fps: Int, chunks: Int, b64Chars: Int): Long {
    val byFps = 1000.0 / max(fps, 1)
    val weight = chunks + b64Chars / 1024.0
    val byBudget = weight / RelayLimits.BUDGET_KBPS * 1000.0
    return kotlin.math.ceil(min(RelayLimits.MAX_DELAY_MS.toDouble(), max(byFps, byBudget))).toLong()
  }

  /** 一段階だけ画質を下げる。下限に着いていれば null（それ以上は下げない） */
  fun lowerQuality(quality: Double, scale: Double): Pair<Double, Double>? = when {
    quality > RelayLimits.MIN_QUALITY + 1e-9 ->
      Pair(max(RelayLimits.MIN_QUALITY, quality - 0.1), scale)
    scale > RelayLimits.MIN_SCALE + 1e-9 ->
      Pair(quality, max(RelayLimits.MIN_SCALE, scale * 0.8))
    else -> null
  }
}

object RelayWire {
  /** base64 の文字だけか（JSON に入れても escape が要らない） */
  fun isBase64(s: String): Boolean {
    if (s.isEmpty()) return false
    for (c in s) {
      val ok = (c in 'A'..'Z') || (c in 'a'..'z') || (c in '0'..'9') || c == '+' || c == '/' || c == '='
      if (!ok) return false
    }
    return true
  }

  /** 1 かけらの payload（受け手の parseChunk の形: 整数 f, i, n と文字列 d） */
  fun chunkJson(frameId: Long, index: Int, total: Int, data: String): String {
    val from = index * RelayLimits.CHUNK_CHARS
    val to = min(data.length, from + RelayLimits.CHUNK_CHARS)
    return "{\"f\":$frameId,\"i\":$index,\"n\":$total,\"d\":\"" + data.substring(from, to) + "\"}"
  }
}

/**
 * 送る側の本体（1 回の画面の共有）。latest（1 枚）と in-flight（1 枚）だけを持つ。
 * 1 回の step で、かけら 1 つだけを送る（待つときは短く戻る）。
 */
class ShareRelay(
  private val config: RelayConfig,
  private val fps: Int,
  private val port: RelayPort,
  private val ids: FrameIdSource = FrameIdAllocator(System.currentTimeMillis()),
) {
  val counters = RelayCounters()

  private var bound: RelayBinding? = null
  private var running = false
  private var paused = false
  private var members: Set<String> = emptySet()
  private var needAnnounce = false
  private var latest: String? = null
  private var lastData: String? = null
  private var sending: Sending? = null
  private var nextFrameAt = 0L
  private var lastFrameSentAt = 0L
  private var lastStateAt = 0L
  private var oversizeAt: Long? = null

  private class Sending(val frameId: Long, val data: String, val chunks: Int, val startedAt: Long) {
    var next = 0
  }

  val isRunning: Boolean get() = running

  /**
   * 始める。通話が送ってよい状態のときだけ（呼び出し側は許可のあとに確かめ直す）。
   * 受け手に見せる f は ids から取る（撮りをまたいでも戻さない）。
   */
  fun start(b: RelayBinding, nowMs: Long, members: Set<String>): Boolean {
    if (running || !RelayPolicy.startable(b)) return false
    bound = b
    running = true
    paused = false
    this.members = members
    needAnnounce = true
    latest = null
    lastData = null
    sending = null
    nextFrameAt = nowMs
    lastFrameSentAt = nowMs
    lastStateAt = nowMs - RelayLimits.HEARTBEAT_MS
    return true
  }

  /** 新しいフレーム（base64）。最新の 1 枚だけを残す */
  fun offer(data: String, nowMs: Long) {
    if (!running) return
    counters.inc(RelayCount.PRODUCED)
    if (!RelayWire.isBase64(data)) {
      counters.inc(RelayCount.DROPPED_INVALID)
      return
    }
    if (data.length > RelayLimits.MAX_FRAME_CHARS) {
      counters.inc(RelayCount.DROPPED_OVERSIZE)
      val last = oversizeAt
      if (last == null || nowMs - last >= RelayLimits.OVERSIZE_GAP_MS) {
        oversizeAt = nowMs
        port.onOversize()
      }
      return
    }
    if (latest != null) counters.inc(RelayCount.DROPPED_REPLACED)
    latest = data
    counters.inc(RelayCount.ENQUEUED)
  }

  /** 相手が問い合わせた（同じ通話のときだけ）。状態と最新の 1 枚をすぐ送り直す */
  fun onQuery(session: String, generation: Long) {
    val b = bound ?: return
    if (!running || session != b.session || generation != b.generation) return
    counters.inc(RelayCount.QUERY)
    needAnnounce = true
  }

  /** 一覧の人が変わった（入った・出た）。状態と最新の 1 枚を送り直す */
  fun onMembers(now: Set<String>) {
    if (!running || now == members) return
    members = now
    counters.inc(RelayCount.MEMBER_ANNOUNCE)
    needAnnounce = true
  }

  /** 明示の停止（ユーザー・投稿の終わり・プロジェクションの停止など）。同じ通話なら off を 1 回送る */
  fun stop(code: String) {
    if (running) end(code)
  }

  /** 入り口から取り出した分を、順に渡す（人の一覧 → 問い合わせ → 最新のフレーム）。null は何もしない */
  fun apply(batch: RelayInbox.Batch?, nowMs: Long) {
    if (batch == null) return
    batch.members?.let { onMembers(it) }
    batch.query?.let { onQuery(it.first, it.second) }
    batch.frame?.let { offer(it, nowMs) }
  }

  /**
   * 一歩進める。返り値は次に呼ぶまでのミリ秒。0 はすぐ、-1 は止まった（もう呼ばない）。
   */
  fun step(nowMs: Long): Long {
    if (!running) return -1
    val b = bound ?: return -1
    val read = port.binding()
    when (val v = RelayPolicy.classify(b, read)) {
      is Verdict.Ended -> {
        end(v.code)
        return -1
      }
      Verdict.Paused, Verdict.Unavailable -> {
        if (v == Verdict.Unavailable) counters.inc(RelayCount.BINDING_UNAVAILABLE)
        if (!paused) {
          paused = true
          counters.inc(RelayCount.PAUSED)
          if (sending != null) {
            counters.inc(RelayCount.DROPPED_PAUSED)
            sending = null
          }
        }
        return RelayLimits.PAUSED_POLL_MS
      }
      Verdict.Active -> {}
    }
    if (paused) {
      // 同じ通話に戻った。状態と、最後の 1 枚を新しい番号で送り直す
      paused = false
      needAnnounce = true
    }
    if (needAnnounce) {
      needAnnounce = false
      sendState(b, nowMs)
      if (latest == null && sending == null) latest = lastData
    }
    if (nowMs - lastStateAt >= RelayLimits.HEARTBEAT_MS) sendState(b, nowMs)

    sending?.let {
      if (nowMs - it.startedAt > RelayLimits.EXPIRY_MS) {
        counters.inc(RelayCount.DROPPED_EXPIRED)
        sending = null
      }
    }
    if (sending == null && latest == null && lastData != null && nowMs - lastFrameSentAt >= RelayLimits.KEEPALIVE_MS) {
      latest = lastData
      counters.inc(RelayCount.KEEPALIVE)
    }
    if (sending == null) {
      val l = latest
      if (l != null && nowMs >= nextFrameAt) {
        latest = null
        val chunks = (l.length + RelayLimits.CHUNK_CHARS - 1) / RelayLimits.CHUNK_CHARS
        sending = Sending(ids.next(), l, chunks, nowMs)
        lastData = l
      }
    }

    val s = sending ?: return idleDelay(nowMs)
    // 送信待ちが読めない・多いときは送らない（まとめて吐き出さない。古くなった途中のフレームは期限で捨てる）
    val queued = port.queuedBytes()
    if (queued == null) {
      counters.inc(RelayCount.QUEUE_UNKNOWN)
      return RelayLimits.RETRY_MS
    }
    if (queued > RelayLimits.QUEUE_LIMIT_BYTES) {
      counters.inc(RelayCount.QUEUE_WAIT)
      return RelayLimits.RETRY_MS
    }
    val r = port.emit(b, config.names.frame, RelayWire.chunkJson(s.frameId, s.next, s.chunks, s.data))
    if (!r.ok) {
      // 途中のフレームは捨てる（かけらを後から送り直さない）
      counters.inc(RelayCount.EMIT_REFUSED)
      counters.inc(RelayCount.DROPPED_REFUSED)
      sending = null
      return RelayLimits.RETRY_MS
    }
    counters.inc(RelayCount.SENT_CHUNKS)
    s.next++
    if (s.next >= s.chunks) {
      sending = null
      lastFrameSentAt = nowMs
      nextFrameAt = nowMs + RelayPacing.intervalMs(fps, s.chunks, s.data.length)
      counters.inc(RelayCount.SENT_FRAMES)
    }
    return 0L
  }

  private fun idleDelay(nowMs: Long): Long {
    var d = RelayLimits.HEARTBEAT_MS - (nowMs - lastStateAt)
    if (lastData != null) d = min(d, RelayLimits.KEEPALIVE_MS - (nowMs - lastFrameSentAt))
    if (latest != null) d = min(d, nextFrameAt - nowMs)
    return d.coerceIn(RelayLimits.RETRY_MS, RelayLimits.HEARTBEAT_MS)
  }

  private fun sendState(b: RelayBinding, nowMs: Long) {
    lastStateAt = nowMs
    val r = port.emit(b, config.names.state, config.onStateJson)
    if (r.ok) counters.inc(RelayCount.STATE_SENT) else counters.inc(RelayCount.EMIT_REFUSED)
  }

  private fun end(code: String) {
    val b = bound
    running = false
    bound = null
    if (b != null) {
      // 読めた同じ通話で、まだ一覧にいるときだけ off を送る（読めないときは送らない）
      val now = RelayPolicy.callOf(port.binding())
      if (now != null && now.session == b.session && now.generation == b.generation && now.listed) {
        port.emit(b, config.names.state, RelayConfig.OFF_STATE_JSON)
      }
    }
    sending = null
    latest = null
    lastData = null
    port.onEnded(code)
  }
}
