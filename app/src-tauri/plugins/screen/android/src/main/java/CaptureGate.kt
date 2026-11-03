package dev.disnans.screen

/** 許可のダイアログを待っている撮りの要求（すべてのモードで、この 1 件だけ） */
class PendingCapture<I : Any, P>(val invoke: I, val captureId: Long, val payload: P)

/**
 * 撮りの要求の受け付け（純粋）。同時に 1 件まで。
 * 結果（許可・取り消し）は、要求したのと同じ呼び出し（invoke の同一性）でだけ取り出す。
 * 違う呼び出しの結果は、待ちを消さない。
 */
class CaptureGate<I : Any, P> {
  private var pending: PendingCapture<I, P>? = null

  /** 要求を待ちにする。false は、ほかの要求が待っている（busy） */
  @Synchronized
  fun begin(invoke: I, captureId: Long, payload: P): Boolean {
    if (pending != null) return false
    pending = PendingCapture(invoke, captureId, payload)
    return true
  }

  /** 結果を取り出す。同じ invoke のときだけ。違うときは何も消さない（null） */
  @Synchronized
  fun take(invoke: I): PendingCapture<I, P>? {
    val p = pending ?: return null
    if (p.invoke !== invoke) return null
    pending = null
    return p
  }

  /** 番号が一致する待ちだけを取り消す（番号 0 は、番号のない待ちに一致する） */
  @Synchronized
  fun cancelIf(captureId: Long): Boolean {
    val p = pending ?: return false
    if (p.captureId != captureId) return false
    pending = null
    return true
  }

  /** 待っている要求の番号（無ければ null）。撮りが始まる前から、この番号は今のものとして扱う */
  @Synchronized
  fun pendingId(): Long? = pending?.captureId

  @Synchronized
  fun isBusy(): Boolean = pending != null

  /** 後始末（Activity が消えるとき）。待ちを捨てる */
  @Synchronized
  fun clear() {
    pending = null
  }
}

/** サービスの開始待ち。古い Intent は、新しい予約を取り出せない。 */
class CaptureStarts<P : Any> {
  private var pending: Pair<Long, P>? = null

  @Synchronized
  fun reserve(id: Long, payload: P) { pending = id to payload }

  @Synchronized
  fun take(id: Long): P? {
    val p = pending ?: return null
    if (p.first != id) return null
    pending = null
    return p.second
  }

  @Synchronized
  fun cancel(id: Long): Boolean {
    if (pending?.first != id) return false
    pending = null
    return true
  }
}

/** 撮りの持ち主。番号 0 は正の番号の撮りには届かない（ワイルドカードにしない）。 */
class CaptureOwner {
  private var id: Long? = null

  @Synchronized
  fun current(): Long? = id

  /** 新しい撮りが持ち主になる（待ちの時点で。撮りが始まるのを待たない） */
  @Synchronized
  fun claim(captureId: Long) {
    id = captureId
  }

  /** 持ち主が同じ番号のときだけ手放す */
  @Synchronized
  fun release(captureId: Long): Boolean {
    if (id != captureId) return false
    id = null
    return true
  }

  @Synchronized
  fun accepts(target: Long): Boolean = if (target == 0L) (id == null || id == 0L) else target == id
}
