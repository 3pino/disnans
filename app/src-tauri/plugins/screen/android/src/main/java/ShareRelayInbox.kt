package dev.disnans.screen

/**
 * 中継への入り口（純粋）。受け取ったものは、上限のある形で持つ。
 * フレームは最新の 1 枚だけ。通話の出来事（人の一覧・問い合わせ）は、合わせて 1 つずつ。
 * 実行を起こすのは、起きていないときの 1 回だけ（待ちが積み上がらない）。閉じたら、待ちを捨てて以後は受けない。
 */
class RelayInbox {
  /** 1 回の実行で、まとめて取り出したもの */
  class Batch(val frame: String?, val members: Set<String>?, val query: Pair<String, Long>?)

  private val lock = Any()
  private var closed = false
  private var scheduled = false
  private var frame: String? = null
  private var members: Set<String>? = null
  private var query: Pair<String, Long>? = null
  private var replacedFrames = 0L

  /** 押し出された（まだ送られていない）フレームの数 */
  val replaced: Long get() = synchronized(lock) { replacedFrames }

  /** true は「実行を起こしてほしい」（まだ起こしていないときだけ） */
  fun offerFrame(data: String): Boolean = synchronized(lock) {
    if (closed) return false
    if (frame != null) replacedFrames++
    frame = data
    wakeLocked()
  }

  fun offerMembers(now: Set<String>): Boolean = synchronized(lock) {
    if (closed) return false
    members = now
    wakeLocked()
  }

  fun offerQuery(session: String, generation: Long): Boolean = synchronized(lock) {
    if (closed) return false
    query = Pair(session, generation)
    wakeLocked()
  }

  private fun wakeLocked(): Boolean {
    if (scheduled) return false
    scheduled = true
    return true
  }

  /** 実行の側が呼ぶ。待ちを取り出し、次の受け付けは改めて起こせるようにする */
  fun take(): Batch? = synchronized(lock) {
    scheduled = false
    if (closed) {
      frame = null
      members = null
      query = null
      return null
    }
    val b = Batch(frame, members, query)
    frame = null
    members = null
    query = null
    if (b.frame == null && b.members == null && b.query == null) null else b
  }

  /** 受け付けを止める。待ちは捨てる（以後の受け付けは無視する） */
  fun close() = synchronized(lock) {
    closed = true
    frame = null
    members = null
    query = null
  }

  /** 閉じた後は off の通知だけを許す。実行中の一歩も、送信の直前にこの門を通る。 */
  fun mayEmit(isOffState: Boolean): Boolean = synchronized(lock) { !closed || isOffState }

  val isClosed: Boolean get() = synchronized(lock) { closed }
}

/**
 * 始めるかどうかの門（純粋）。始める処理は、取り消されていなければ一度だけ走る。
 * 取り消し（時間切れ・止める）のあとは、始めない。始めたあとの取り消しは、止める必要がある（戻り値で知らせる）。
 */
class ActivationGate {
  private val lock = Any()
  private var abandoned = false
  private var activated = false

  /** 取り消されていなければ start を一度だけ走らせる。start が true を返したら、始まったと記録する */
  fun activate(start: () -> Boolean): Boolean = synchronized(lock) {
    if (abandoned || activated) return false
    val ok = start()
    if (ok) activated = true
    ok
  }

  /** 取り消す。戻り値は「もう始まっていた」（止める必要がある） */
  fun abandon(): Boolean = synchronized(lock) {
    abandoned = true
    activated
  }

  val isActivated: Boolean get() = synchronized(lock) { activated }
}
