package dev.disnans.screen

import android.content.Context
import android.os.SystemClock
import dev.disnans.notifier.DiagLog
import dev.disnans.notifier.NativeCallEvent
import dev.disnans.notifier.NativeCallHost
import dev.disnans.notifier.NativeCallPhase
import dev.disnans.notifier.NativeCallSnapshot
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * 通話（NativeCallHost）と、中継の本体（ShareRelay）をつなぐ窓口。Android の実物はここだけ。
 * 入り口は RelayInbox（上限つき）。すべての送信と状態の変更は、ひとつの実行（disnans-screen-relay）で行う。
 * 撮りのスレッドや、画面の描画のスレッドからは、送らない（入り口に置くだけ）。
 * 通話の状態は読むだけ。通話を始める・止める・マイクに触ることはしない。
 */
class ShareRelayHost(
  appContext: Context,
  config: RelayConfig,
  fps: Int,
  private val oversizeSink: () -> Unit,
  private val endedSink: (String) -> Unit,
) : RelayPort {
  private val app = appContext.applicationContext
  private val exec = Executors.newSingleThreadScheduledExecutor { r ->
    Thread(r, "disnans-screen-relay").apply { isDaemon = true }
  }
  private val relay = ShareRelay(config, fps, this, ids)
  private val inbox = RelayInbox()
  private val queryName = config.names.query
  private val stateName = config.names.state
  private val previewSuppressed = AtomicLong(0)
  private val ended = AtomicBoolean(false)
  private val stopping = AtomicBoolean(false)
  private val activation = ActivationGate()
  private val lock = Any()
  // 以下は lock で守る
  private var removeListener: (() -> Unit)? = null
  @Volatile private var wake: ScheduledFuture<*>? = null
  @Volatile private var logTask: ScheduledFuture<*>? = null

  companion object {
    private const val START_WAIT_MS = 2000L
    private const val LOG_EVERY_SEC = 5L

    /** プロセス全体で 1 つ。撮りをまたいでも f が戻らないように、時計の値から始める */
    private val ids: FrameIdSource = FrameIdAllocator(System.currentTimeMillis(), System::currentTimeMillis)

    /**
     * 通話の読み取り（読むだけ）。読めなかったら Unavailable（通話が終わったとは決めない）。
     * session が無いときだけ、通話が無いと確かめたこと（NoCall）になる。
     */
    fun readBinding(context: Context): BindingRead {
      val s = NativeCallHost.snapshot(context.applicationContext) ?: return BindingRead.Unavailable
      val session = s.session ?: return BindingRead.NoCall
      return BindingRead.Call(
        RelayBinding(
          session = session,
          generation = s.generation,
          joined = s.phase == NativeCallPhase.JOINED,
          listed = s.listed,
          wanted = s.wanted,
        ),
      )
    }
  }

  /**
   * 中継を始める（許可のあとに、通話を確かめてから呼ぶ）。返り値 false は始まらなかった（後始末は済んでいる）。
   * 時間切れのあとで、遅れて始まることはない（始まる前に、取り消しを確かめる）。
   */
  fun begin(b: RelayBinding): Boolean {
    val f: Future<Boolean> = exec.submit(Callable { activate(b) })
    val ok = try {
      f.get(START_WAIT_MS, TimeUnit.MILLISECONDS)
    } catch (_: Exception) {
      false
    }
    if (!ok) {
      // 取り消す。すでに始まっていたら、下の stop で止める
      activation.abandon()
      f.cancel(false)
      stop("begin_failed")
    }
    return ok
  }

  /** 実行の中。読み取りのあとで、取り消されていないことを確かめてから始める */
  private fun activate(b: RelayBinding): Boolean {
    val members = membersNow()
    val started = activation.activate {
      if (ended.get() || !relay.start(b, SystemClock.elapsedRealtime(), members)) return@activate false
      synchronized(lock) { removeListener = NativeCallHost.addListener { ev -> onEvent(ev) } }
      true
    }
    if (!started) return false
    scheduleLog()
    schedule(0L)
    DiagLog.i("[screen-relay] 開始")
    return true
  }

  /** 撮ったフレームの送り先（入り口に置くだけ。上限は入り口が守る） */
  fun sink(): (CapturedFrame) -> Unit = { f -> offer(f) }

  fun offer(frame: CapturedFrame) {
    if (ended.get()) return
    if (inbox.offerFrame(frame.data)) submitDrain()
  }

  /** 途中の画像を JS へ渡さなかった数（ログ用） */
  fun notePreviewSuppressed() {
    previewSuppressed.incrementAndGet()
  }

  /**
   * 止める。入り口は、ここで閉じる（待ちのフレームは捨てる。実行が忙しくても、以後は送らない）。
   * 送り手の終わりは、実行の中で行う（off を送ってから）。
   */
  fun stop(code: String) {
    if (ended.get() || !stopping.compareAndSet(false, true)) return
    activation.abandon()
    inbox.close()
    synchronized(lock) {
      removeListener?.invoke()
      removeListener = null
    }
    try {
      exec.execute {
        relay.stop(code)
        finish(code)
      }
    } catch (_: RejectedExecutionException) {
      finish(code)
    }
  }

  private fun membersNow(): Set<String> =
    NativeCallHost.snapshot(app)?.members?.map { it.peer }?.toSet() ?: emptySet()

  /** 通話の出来事（ループバックのスレッド）。待ちに置くだけ（1 つずつ。実行を起こすのは起きていないときだけ） */
  private fun onEvent(ev: NativeCallEvent) {
    if (ended.get()) return
    when (ev) {
      is NativeCallEvent.State -> {
        if (inbox.offerMembers(ev.snapshot.members.map { it.peer }.toSet())) submitDrain()
      }
      is NativeCallEvent.Relay -> {
        val q = queryName
        if (q != null && ev.relay.name == q && inbox.offerQuery(ev.relay.session, ev.relay.generation)) submitDrain()
      }
    }
  }

  private fun submitDrain() {
    try {
      exec.execute { drain() }
    } catch (_: RejectedExecutionException) {
      // 止まった後
    }
  }

  /** 実行の中。待ちを取り出して、順に渡す（フレームは最新の 1 枚だけ） */
  private fun drain() {
    if (ended.get()) return
    relay.apply(inbox.take(), SystemClock.elapsedRealtime())
    schedule(0L)
  }

  private fun schedule(delayMs: Long) {
    if (ended.get()) return
    wake?.cancel(false)
    wake = exec.schedule(Runnable { runStep() }, delayMs, TimeUnit.MILLISECONDS)
  }

  private fun runStep() {
    if (ended.get()) return
    val d = relay.step(SystemClock.elapsedRealtime())
    if (d >= 0) schedule(d)
  }

  private fun scheduleLog() {
    logTask = exec.scheduleAtFixedRate(Runnable {
      if (!ended.get()) {
        DiagLog.i("[screen-relay] 数: ${relay.counters.line()} preview_suppressed=${previewSuppressed.get()} 押し出し=${inbox.replaced}")
      }
    }, LOG_EVERY_SEC, LOG_EVERY_SEC, TimeUnit.SECONDS)
  }

  /** 終わり（一度だけ）。実行を止め、終わりを知らせる */
  private fun finish(code: String) {
    if (!ended.compareAndSet(false, true)) return
    stopping.set(true)
    inbox.close()
    synchronized(lock) {
      removeListener?.invoke()
      removeListener = null
    }
    wake?.cancel(false)
    logTask?.cancel(false)
    if (activation.isActivated) DiagLog.i("[screen-relay] 停止: $code ${relay.counters.line()} preview_suppressed=${previewSuppressed.get()}")
    exec.shutdown()
    endedSink(code)
  }

  // ---- RelayPort（実行の中から呼ばれる） ----

  override fun binding(): BindingRead = readBinding(app)

  override fun emit(b: RelayBinding, name: String, payloadJson: String): RelayEmit {
    if (!inbox.mayEmit(name == stateName && payloadJson == RelayConfig.OFF_STATE_JSON)) return RelayEmit(false, "stopped")
    val o = NativeCallHost.emitScoped(app, b.session, b.generation, name, payloadJson)
    return RelayEmit(o.ok, o.code)
  }

  /**
   * 送信待ちのバイト（通話の読み取りのたびに、ソケットの今の値を取る）。
   * 読めないとき（null）は、送らずに待つ。0 とは扱わない。
   */
  override fun queuedBytes(): Long? = NativeCallHost.snapshot(app)?.bufferedBytes

  override fun onOversize() {
    oversizeSink()
  }

  override fun onEnded(code: String) {
    finish(code)
  }
}
