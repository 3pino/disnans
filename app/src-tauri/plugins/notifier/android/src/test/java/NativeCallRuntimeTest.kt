package dev.disnans.notifier

import com.fasterxml.jackson.databind.ObjectMapper
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * 実行の中心（[NativeCallRuntime]）の試験。本物の制御のスレッド・io のスレッドを使い、
 * 保存・通信・録音・経路・サービス・タイマーは偽物（ポート）にする。デバイス・マイク・通信は使わない。
 */
object NativeCallRuntimeTest {
  private val status = NativeCallStatus(muted = false, deafened = false, device = "smartphone")
  private val settings = NativeCallSettings(1.0, 1.0, true, -6.0, false, null)
  private val json = ObjectMapper()

  /** 順番の記録（保存・通信の閉じ・録音の停止など） */
  private class Trace {
    private val items = ArrayList<String>()
    @Synchronized fun add(s: String) { items.add(s) }
    @Synchronized fun indexOf(s: String): Int = items.indexOf(s)
    @Synchronized fun contains(s: String): Boolean = items.contains(s)
  }

  private class FakeStore(private val trace: Trace, generation: Long = 0L) : NativeCallStore {
    @Volatile var wanted = false
    @Volatile var config: CallSessionConfig? = null
    @Volatile var generation = generation
    @Volatile var status: NativeCallStatus = NativeCallStatus(muted = false, deafened = false, device = "smartphone")
    @Volatile var localMuted: Set<String> = emptySet()
    @Volatile var muteByDeafen = false
    /** 書けない（消せない・保存できない）ことを模す。状態は変わらない */
    @Volatile var failClear = false
    @Volatile var failWanted = false

    override fun read(): CallPersisted = CallPersisted(
      wanted = wanted,
      config = if (wanted) config else null,
      settings = settings,
      status = status,
      localMuted = localMuted,
      generation = generation,
      muteByDeafen = muteByDeafen,
    )
    override fun commitGeneration(generation: Long): Boolean {
      this.generation = generation
      trace.add("gen:$generation")
      return true
    }
    override fun commitSettings(settings: NativeCallSettings): Boolean = true
    override fun commitSession(status: NativeCallStatus, localMuted: Set<String>, muteByDeafen: Boolean): Boolean {
      this.status = status
      this.localMuted = localMuted
      this.muteByDeafen = muteByDeafen
      return true
    }
    override fun commitWanted(config: CallSessionConfig, status: NativeCallStatus, localMuted: Set<String>, muteByDeafen: Boolean): Boolean {
      if (failWanted) return false
      this.config = config
      this.status = status
      this.localMuted = localMuted
      this.muteByDeafen = muteByDeafen
      wanted = true
      trace.add("store:wanted:true")
      return true
    }
    override fun clearWanted(): Boolean {
      if (failClear) {
        trace.add("store:clear:failed")
        return false
      }
      wanted = false
      config = null
      trace.add("store:wanted:false")
      return true
    }
  }

  private class FakeSocket(val listener: CallSocketListener, private val trace: Trace, val id: Int) : CallSocket {
    val controls = ArrayList<String>()
    val audio = ArrayList<String>()
    @Volatile var closed = false
    override fun connect(serverUrl: String, devUser: String?) { trace.add("socket:$id:connect") }
    override fun sendControl(text: String): Boolean { synchronized(controls) { controls.add(text) }; return true }
    override fun sendAudio(text: String): Boolean { synchronized(audio) { audio.add(text) }; return true }
    override fun queuedBytes(): Long = 0L
    override fun close() { closed = true; trace.add("socket:$id:close") }
    override fun cancel() { closed = true; trace.add("socket:$id:cancel") }
    fun sent(): List<String> = synchronized(controls) { controls.toList() }
    fun sentAudio(): List<String> = synchronized(audio) { audio.toList() }
  }

  private class FakeSockets(private val trace: Trace) : CallSocketFactory {
    val made = ArrayList<FakeSocket>()
    override fun create(listener: CallSocketListener): CallSocket {
      val s = FakeSocket(listener, trace, made.size + 1)
      made.add(s)
      return s
    }
  }

  private class FakeRun(
    private val trace: Trace,
    private val id: Int,
    val sender: (Long, ByteArray) -> Unit,
    val onFailure: (String) -> Unit,
    private val startGate: CountDownLatch?,
    private val startCode: String?,
  ) : AudioRun {
    @Volatile var started = false
    @Volatile var stopped = false
    /** true のあいだ、stop の後も解放されない（awaitReleased は偽） */
    @Volatile var unreleased = false
    @Volatile var startCount = 0
    val captures = ArrayList<Boolean>()
    override fun start(): String? {
      startCount += 1
      startGate?.await(2, TimeUnit.SECONDS)
      started = true
      return startCode
    }
    override fun setCapture(enabled: Boolean) { synchronized(captures) { captures.add(enabled) } }
    override fun setMicVolume(volume: Double) {}
    override fun stop() { stopped = true; trace.add("audio:$id:stop") }
    override fun awaitReleased(timeoutMs: Long): Boolean = !unreleased
  }

  private class FakeAudio(private val trace: Trace) : AudioFactory {
    val runs = ArrayList<FakeRun>()
    @Volatile var created = 0
    /** 作られる録音に、解放されない印を付ける（前の録音が解放されない状況を模す） */
    @Volatile var makeUnreleased = false
    var startGate: CountDownLatch? = null
    var startCode: String? = null
    override fun preflight(rawInput: Boolean): String? = null
    override fun create(
      rawInput: Boolean,
      micVolume: Double,
      mixer: NativeMixer,
      sender: (seq: Long, pcm: ByteArray) -> Unit,
      onFailure: (code: String) -> Unit,
    ): AudioRun {
      created += 1
      val r = FakeRun(trace, runs.size + 1, sender, onFailure, startGate, startCode)
      r.unreleased = makeUnreleased
      runs.add(r)
      return r
    }
  }

  private class FakeRoute : RoutePort {
    var begins = 0
    var ends = 0
    override fun begin() { begins++ }
    override fun end() { ends++ }
    override fun select(outputId: String): Boolean = true
  }

  private class FakeService(private val trace: Trace) : ServicePort {
    val started = ArrayList<String>()
    var stops = 0
    var running = false
    override fun start(session: String): Boolean { started.add(session); return true }
    override fun stop() { stops++; trace.add("service:stop") }
    override fun isRunning(): Boolean = running
    override fun refresh(snapshot: NativeCallSnapshot) {}
  }

  private class FakeTimers : TimerPort {
    val tasks = ArrayList<Runnable>()
    override fun schedule(delayMs: Long, task: Runnable): () -> Unit {
      synchronized(tasks) { tasks.add(task) }
      return {}
    }
    /** いま予約されているものを、一度ずつ実行する（繰り返しは、実行された中でまた予約される） */
    fun runOnce() {
      val now = synchronized(tasks) { tasks.toList().also { tasks.clear() } }
      for (t in now) t.run()
    }
  }

  private class Rig(
    storeGeneration: Long = 0L,
    startGate: CountDownLatch? = null,
    seed: FakeStore.() -> Unit = {},
    micPermitted: () -> Boolean = { true },
    audioUnreleased: Boolean = false,
  ) {
    val trace = Trace()
    val store = FakeStore(trace, storeGeneration).also(seed)
    val sockets = FakeSockets(trace)
    val audio = FakeAudio(trace).also { it.startGate = startGate; it.makeUnreleased = audioUnreleased }
    val route = FakeRoute()
    val service = FakeService(trace)
    val timers = FakeTimers()
    val events = ArrayList<NativeCallEvent>()
    val clock = java.util.concurrent.atomic.AtomicLong(1_000L)
    val logs = ArrayList<String>()
    val control: ExecutorService = Executors.newSingleThreadExecutor()
    val io: ExecutorService = Executors.newSingleThreadExecutor()
    private var peerSeq = 0
    val runtime = NativeCallRuntime(
      store = store,
      sockets = sockets,
      audio = audio,
      route = route,
      service = service,
      timers = timers,
      control = control,
      io = io,
      publish = { e -> synchronized(events) { events.add(e) } },
      log = object : RuntimeLog {
        override fun info(message: String) { synchronized(logs) { logs.add(message) } }
        override fun warn(message: String) { synchronized(logs) { logs.add(message) } }
      },
      peerFactory = { "peer${++peerSeq}" },
      callTimeoutMs = 5_000L,
      nowMs = { clock.get() },
      micPermitted = micPermitted,
    )

    fun close() {
      control.shutdownNow()
      io.shutdownNow()
    }

    fun stateEvents(): List<NativeCallSnapshot> = synchronized(events) {
      events.mapNotNull { (it as? NativeCallEvent.State)?.snapshot }
    }

    fun allEvents(): List<NativeCallEvent> = synchronized(events) { events.toList() }
  }

  private fun waitUntil(what: String, cond: () -> Boolean) {
    val end = System.currentTimeMillis() + 3_000
    while (System.currentTimeMillis() < end) {
      if (cond()) return
      Thread.sleep(3)
    }
    throw AssertionError("時間内に起きませんでした: $what")
  }

  private fun args(session: String, user: String = "ua") =
    NativeCallStartArgs(session, "https://example.invalid", user, null, status, settings, emptyList())

  /** 準備から、参加（保存まで）まで。返り値は初回の参加に使う peer */
  private fun join(r: Rig, session: String, user: String = "ua"): String {
    Check.that(r.runtime.prepare(args(session, user)).ok) { "prepare" }
    Check.that(r.runtime.startPrepared(session).ok) { "startPrepared" }
    waitUntil("service start") { r.service.started.contains(session) }
    val promoted = r.runtime.servicePromoted(session)
    Check.that(promoted > 0) { "promoted run" }
    val before = r.sockets.made.size
    r.runtime.serviceStarted(session, true)
    waitUntil("socket connect for this session") { r.sockets.made.size > before }
    val sock = r.sockets.made.last()
    sock.listener.onFrame(ServerFrame.Hello(meId = user, meLoginName = null))
    waitUntil("join sent") { sock.sent().any { it.contains("call.join") } }
    val peer = r.runtime.snapshot().peer ?: throw AssertionError("peer")
    sock.listener.onFrame(ServerFrame.CallState(listOf(NativeCallMember(peer, user, status))))
    waitUntil("audio run started") { r.audio.runs.isNotEmpty() && r.audio.runs.last().started }
    waitUntil("wanted committed") { r.store.wanted }
    waitUntil("joined") { r.runtime.snapshot().phase == NativeCallPhase.JOINED }
    return peer
  }

  fun run() {
    // 1. 準備は、権限より前に ID を登録する（資源は動かさない）。世代は保存される
    run {
      val r = Rig()
      try {
        Check.that(r.runtime.prepare(args("s1")).ok) { "prepare ok" }
        Check.eq("s1", r.runtime.snapshot().session, "session registered by prepare")
        Check.that(r.trace.contains("gen:1")) { "generation persisted by prepare" }
        Check.that(r.service.started.isEmpty() && r.sockets.made.isEmpty() && r.audio.runs.isEmpty()) { "prepare starts nothing" }
        Check.eq(false, r.runtime.prepare(args("s2")).ok, "second prepare is busy")
      } finally {
        r.close()
      }
    }

    // 2. 新しいプロセスの初回の準備も、保存された世代より大きくなる（1 に戻らない）
    run {
      val r = Rig(storeGeneration = 99L)
      try {
        r.runtime.prepare(args("s1"))
        Check.eq(100L, r.runtime.snapshot().generation, "generation starts from saved 99")
        Check.that(r.trace.contains("gen:100")) { "persisted 100" }
      } finally {
        r.close()
      }
    }

    // 3. 参加して、停止する。停止は、保存（wanted=false）が済んでから戻る。後始末（通信・録音）はその後
    run {
      val r = Rig()
      try {
        join(r, "s1")
        val acked = r.runtime.stop("s1", "user")
        Check.that(acked) { "stop acknowledged" }
        Check.that(!r.store.wanted) { "durable clear visible when stop returns" }
        val iClear = r.trace.indexOf("store:wanted:false")
        val iClose = r.trace.indexOf("socket:1:close")
        Check.that(iClear >= 0 && (iClose < 0 || iClear < iClose)) { "clear before socket close" }
        waitUntil("idle") { r.runtime.snapshot().phase == NativeCallPhase.IDLE }
        Check.that(r.runtime.snapshot().session == null) { "session ended" }
      } finally {
        r.close()
      }
    }

    // 4. 古い通信の応答は、新しい通話を動かさない（試みごとに持ち主を確かめる）
    run {
      val r = Rig()
      try {
        Check.that(r.runtime.prepare(args("s1")).ok) { "prepare s1" }
        Check.that(r.runtime.startPrepared("s1").ok) { "start s1" }
        r.runtime.serviceStarted("s1", true)
        waitUntil("socket1") { r.sockets.made.size == 1 }
        val old = r.sockets.made[0]
        Check.that(r.runtime.stop("s1", "user")) { "stop s1" }
        Check.that(r.runtime.prepare(args("s2")).ok) { "prepare s2" }
        Check.that(r.runtime.startPrepared("s2").ok) { "start s2" }
        r.runtime.serviceStarted("s2", true)
        waitUntil("socket2") { r.sockets.made.size == 2 }
        // 古い接続の応答（つながった通知・挨拶・切断）が、後から届く
        old.listener.onFrame(ServerFrame.Hello(meId = "ua", meLoginName = null))
        old.listener.onClosed("remote_closed")
        Thread.sleep(50)
        val snap = r.runtime.snapshot()
        Check.eq("s2", snap.session, "still the new session")
        Check.eq("joining", snap.phase.wire, "old socket did not move the new session")
        Check.that(snap.error == null) { "old socket error not applied" }
        Check.that(r.sockets.made[1].sent().none { it.contains("call.join") }) { "no join from old socket" }
        Check.that(!r.store.wanted) { "old socket did not arm wanted" }
      } finally {
        r.close()
      }
    }

    // 5. 止めたあとに届いた古い録音の音は、新しい通話へ送られない（録音の番号と、送ってよい状態で確かめる）
    run {
      val r = Rig()
      try {
        join(r, "s1")
        val oldSender = r.audio.runs[0].sender
        r.runtime.stop("s1", "user")
        join(r, "s2", user = "ua")
        val newSocket = r.sockets.made.last()
        oldSender(7L, ByteArray(1600))
        Thread.sleep(50)
        Check.that(newSocket.sentAudio().isEmpty()) { "late frame from stopped run is not sent" }
        val newSender = r.audio.runs.last().sender
        newSender(8L, ByteArray(1600))
        waitUntil("current frame sent") { newSocket.sentAudio().isNotEmpty() }
        Check.that(newSocket.sentAudio().single().contains("\"seq\":8")) { "current run frame sent with its seq" }
      } finally {
        r.close()
      }
    }

    // 6. 状態と中継は、一つの番号の列（世代の中で単調に増える）。停止中・準備中の状態の番号も、最後に出したものと同じ
    run {
      val r = Rig()
      try {
        val peer = join(r, "s1")
        val sock = r.sockets.made.last()
        sock.listener.onFrame(ServerFrame.Relay(peer = "pB", from = "ub", name = "game", payload = json.readTree("{\"x\":1}")))
        sock.listener.onFrame(ServerFrame.CallState(listOf(NativeCallMember(peer, "ua", status))))
        waitUntil("relay published") { r.allEvents().any { it is NativeCallEvent.Relay } }
        Thread.sleep(50)
        val seqs = r.allEvents().map { e ->
          when (e) {
            is NativeCallEvent.State -> e.snapshot.seq
            is NativeCallEvent.Relay -> e.relay.seq
          }
        }
        Check.that(seqs.size >= 3) { "several events: $seqs" }
        Check.that(seqs.zipWithNext().all { (a, b) -> b > a }) { "one strictly increasing sequence: $seqs" }
        Check.eq(seqs.max(), r.runtime.snapshot().seq, "snapshot shows the latest published sequence")
        val relay = r.allEvents().filterIsInstance<NativeCallEvent.Relay>().single().relay
        Check.eq("game", relay.name, "relay name")
        Check.eq(1, relay.payload.get("x").asInt(), "relay payload passes through")
        Check.that(r.stateEvents().all { it.generation == r.runtime.snapshot().generation }) { "one generation" }
      } finally {
        r.close()
      }
    }

    // 7. 通知の停止（プロセスが作り直された後）: 保存された通話の印を、再開より先に消す
    run {
      val seed = Rig()
      val cfg = CallSessionConfig("old", "https://example.invalid", "ua", null, "p0")
      seed.store.config = cfg
      seed.store.wanted = true
      seed.close()
      val r = Rig()
      try {
        r.store.config = cfg
        r.store.wanted = true
        val d = r.runtime.notificationAction(NotificationAction.HANGUP, "old", true)
        Check.that(d.accepted && d.clearWanted && d.stopService) { "cold hangup decision" }
        Check.that(!r.store.wanted) { "saved wanted cleared by cold hangup" }
        Check.that(r.runtime.adopt(permissionOk = true) == false) { "no rejoin after hangup" }
        Check.that(r.service.started.isEmpty()) { "no service started after hangup" }
      } finally {
        r.close()
      }
    }

    // 8. 古い通知・間違った通話の ID・保存の無い通話は効かない
    run {
      val r = Rig()
      try {
        r.store.config = CallSessionConfig("A", "https://example.invalid", "ua", null, "p0")
        r.store.wanted = true
        val stale = r.runtime.notificationAction(NotificationAction.HANGUP, "B", true)
        Check.that(!stale.accepted) { "stale intent ignored" }
        Check.that(r.store.wanted) { "stale hangup keeps wanted" }
        val none = r.runtime.notificationAction(NotificationAction.MUTE, null, true)
        Check.that(!none.accepted && none.stopService) { "intent without session stops if idle" }
        Check.that(r.store.wanted) { "no session keeps wanted" }
      } finally {
        r.close()
      }
    }

    // 9. サービスが壊されたとき、新しい通話は止めない（自分の番号の通話だけを止める）
    run {
      val r = Rig()
      try {
        Check.that(r.runtime.prepare(args("s1")).ok) { "prepare s1" }
        Check.that(r.runtime.startPrepared("s1").ok) { "start s1" }
        val run1 = r.runtime.servicePromoted("s1")
        Check.that(r.runtime.stop("s1", "user")) { "stop s1" }
        Check.that(r.runtime.prepare(args("s2")).ok) { "prepare s2" }
        Check.that(r.runtime.startPrepared("s2").ok) { "start s2" }
        val run2 = r.runtime.servicePromoted("s2")
        r.runtime.serviceDestroyed(run1)
        Thread.sleep(50)
        Check.eq("s2", r.runtime.snapshot().session, "old destroy does not stop s2")
        r.runtime.serviceDestroyed(run2)
        waitUntil("s2 stopped by its own service destroy") { r.runtime.snapshot().session == null }
      } finally {
        r.close()
      }
    }

    // 10. プロセスが強制終了されていない（信号による）再起動: UI の起動では消さず、遅れて来た再起動が再開する
    run {
      val r = Rig()
      try {
        r.store.config = CallSessionConfig("S", "https://example.invalid", "ua", null, "p0")
        r.store.wanted = true
        val cleared = r.runtime.uiLaunch(sdk = 34, lastExit = NativeCallRecovery.EXIT_USER_REQUESTED.minus(8))
        Check.eq(false, cleared, "SIGNALED exit does not clear on UI launch")
        Check.that(r.store.wanted) { "wanted kept for the delayed restart" }
        Check.that(r.runtime.adopt(permissionOk = true)) { "delayed sticky restart resumes" }
        Check.eq(listOf("S"), r.service.started, "restart starts the saved session")
      } finally {
        r.close()
      }
    }

    // 11. 強制終了の証拠（API 30 以上の利用者による停止）があれば、UI の起動で消し、再開しない
    run {
      val r = Rig()
      try {
        r.store.config = CallSessionConfig("S", "https://example.invalid", "ua", null, "p0")
        r.store.wanted = true
        Check.that(r.runtime.uiLaunch(sdk = 34, lastExit = NativeCallRecovery.EXIT_USER_STOPPED)) { "user stop clears" }
        Check.that(!r.store.wanted) { "wanted cleared" }
        Check.that(r.runtime.adopt(permissionOk = true) == false) { "no restart after force stop" }
        Check.that(r.service.started.isEmpty()) { "no service" }
      } finally {
        r.close()
      }
    }

    // 12. 読み取り（スナップショット）は、再開の資源を何も始めない
    run {
      val r = Rig()
      try {
        r.store.config = CallSessionConfig("S", "https://example.invalid", "ua", null, "p0")
        r.store.wanted = true
        val snap = r.runtime.snapshot()
        Check.eq("idle", snap.phase.wire, "idle")
        Check.that(snap.wanted) { "stored wanted shown read-only" }
        Check.that(r.service.started.isEmpty() && r.sockets.made.isEmpty() && r.audio.runs.isEmpty()) { "snapshot starts nothing" }
        Check.that(r.store.wanted) { "snapshot does not clear" }
      } finally {
        r.close()
      }
    }

    // 13. 録音が始まらなかったら、初回の参加は止まり、保存は書かれない
    run {
      val r = Rig()
      try {
        r.audio.startCode = "record_init"
        Check.that(r.runtime.prepare(args("s1")).ok) { "prepare" }
        Check.that(r.runtime.startPrepared("s1").ok) { "start" }
        r.runtime.serviceStarted("s1", true)
        waitUntil("socket") { r.sockets.made.isNotEmpty() }
        r.sockets.made[0].listener.onFrame(ServerFrame.Hello("ua", null))
        waitUntil("join") { r.sockets.made[0].sent().any { it.contains("call.join") } }
        val peer = r.runtime.snapshot().peer!!
        r.sockets.made[0].listener.onFrame(ServerFrame.CallState(listOf(NativeCallMember(peer, "ua", status))))
        waitUntil("idle after audio failure") { r.runtime.snapshot().phase == NativeCallPhase.IDLE }
        Check.that(!r.store.wanted) { "no wanted after audio failure" }
        Check.that(!r.trace.contains("store:wanted:true")) { "wanted never written" }
      } finally {
        r.close()
      }
    }

    // 14. 録音の開始が遅れている間に止めても、遅れて始まった録音は片付けられ、保存は書かれない
    run {
      val gate = CountDownLatch(1)
      val r = Rig(startGate = gate)
      try {
        Check.that(r.runtime.prepare(args("s1")).ok) { "prepare" }
        Check.that(r.runtime.startPrepared("s1").ok) { "start" }
        r.runtime.serviceStarted("s1", true)
        waitUntil("socket") { r.sockets.made.isNotEmpty() }
        r.sockets.made[0].listener.onFrame(ServerFrame.Hello("ua", null))
        waitUntil("join") { r.sockets.made[0].sent().any { it.contains("call.join") } }
        val peer = r.runtime.snapshot().peer!!
        r.sockets.made[0].listener.onFrame(ServerFrame.CallState(listOf(NativeCallMember(peer, "ua", status))))
        waitUntil("run created") { r.audio.runs.isNotEmpty() }
        Check.that(r.runtime.stop("s1", "user")) { "stop while audio is starting" }
        Check.that(r.audio.runs[0].stopped) { "pending run receives stop before the acknowledgement" }
        gate.countDown()
        waitUntil("late run disposed") { r.audio.runs.isNotEmpty() && r.audio.runs[0].stopped }
        Check.that(!r.store.wanted) { "stopped session never persists wanted" }
        Check.that(!r.trace.contains("store:wanted:true")) { "no wanted write after stop" }
      } finally {
        gate.countDown()
        r.close()
      }
    }

    // 15. 保存が書けなかったら、参加は失敗として止まる
    run {
      val r = Rig()
      try {
        r.store.failWanted = true
        Check.that(r.runtime.prepare(args("s1")).ok) { "prepare" }
        Check.that(r.runtime.startPrepared("s1").ok) { "start" }
        r.runtime.serviceStarted("s1", true)
        waitUntil("socket") { r.sockets.made.isNotEmpty() }
        r.sockets.made[0].listener.onFrame(ServerFrame.Hello("ua", null))
        waitUntil("join") { r.sockets.made[0].sent().any { it.contains("call.join") } }
        val peer = r.runtime.snapshot().peer!!
        r.sockets.made[0].listener.onFrame(ServerFrame.CallState(listOf(NativeCallMember(peer, "ua", status))))
        waitUntil("failed to idle") { r.runtime.snapshot().phase == NativeCallPhase.IDLE }
        Check.eq("persist_failed", r.runtime.snapshot().error?.code, "persist failure is the error")
        Check.that(!r.store.wanted) { "not wanted" }
      } finally {
        r.close()
      }
    }

    // 17. 自分の声: 録音の音から大きさを取り、音が途切れたら（時計が進んで）無音になる
    run {
      val r = Rig()
      try {
        join(r, "s1")
        val loud = NativePcm.shortsToLe(ShortArray(800) { (if (it % 2 == 0) 12000 else -12000).toShort() })
        r.clock.addAndGet(10)
        r.audio.runs.last().sender(0L, loud)
        waitUntil("self speaking") { r.stateEvents().lastOrNull()?.speaking?.get("") == true }
        r.clock.addAndGet(1_000)
        r.timers.runOnce()
        waitUntil("self silent after the tick") { r.stateEvents().lastOrNull()?.speaking?.get("") == false }
      } finally {
        r.close()
      }
    }

    // 18. 相手の声: 受けた音の大きさで、その人が話していると分かる
    run {
      val r = Rig()
      try {
        val peer = join(r, "s1")
        val sock = r.sockets.made.last()
        sock.listener.onFrame(ServerFrame.CallState(listOf(NativeCallMember(peer, "ua", status), NativeCallMember("pB", "ub", status))))
        val loud = NativePcm.shortsToLe(ShortArray(800) { (if (it % 2 == 0) 12000 else -12000).toShort() })
        sock.listener.onFrame(ServerFrame.Audio(peer = "pB", from = "ub", seq = 1L, pcm = loud))
        waitUntil("remote speaking") { r.stateEvents().lastOrNull()?.speaking?.get("pB") == true }
      } finally {
        r.close()
      }
    }

    // 19. 診断: 状態と数だけの 1 行（音・ID は入らない）
    run {
      val r = Rig()
      try {
        join(r, "s1")
        r.timers.runOnce()
        waitUntil("diagnostic line") { synchronized(r.logs) { r.logs.any { it.startsWith("[native-call] 状態=") } } }
        val line = synchronized(r.logs) { r.logs.first { it.startsWith("[native-call] 状態=") } }
        Check.that(line.contains("数:") && !line.contains("peer") && !line.contains("ua")) { "diagnostic has counts and no identities: $line" }
      } finally {
        r.close()
      }
    }

    // 20. 世代（エポック）は停止のたびに保存され、新しいプロセスは保存された値より大きく始まる
    run {
      val r = Rig()
      try {
        join(r, "s1")
        Check.that(r.runtime.stop("s1", "user")) { "stop acked" }
        Check.eq(2L, r.store.generation, "stop persists the next epoch")
        val r2 = Rig(storeGeneration = r.store.generation)
        try {
          r2.runtime.prepare(args("s2"))
          Check.eq(3L, r2.store.generation, "new process continues from the persisted epoch")
          Check.eq(3L, r2.runtime.snapshot().generation, "snapshot shows the new epoch")
        } finally {
          r2.close()
        }
      } finally {
        r.close()
      }
    }

    // 21. 停止の保存が 3 回とも書けなければ、ACK は偽。後始末（録音・通信・サービス）は済み、再開はしない
    run {
      val r = Rig()
      try {
        join(r, "s1")
        r.store.failClear = true
        Check.eq(false, r.runtime.stop("s1", "user"), "stop not acknowledged when the save fails")
        Check.that(r.sockets.made[0].closed) { "socket closed despite save failure" }
        Check.that(r.audio.runs[0].stopped) { "audio stopped despite save failure" }
        Check.that(r.service.stops >= 1) { "service stopped despite save failure" }
        val snap = r.runtime.snapshot()
        Check.eq("idle", snap.phase.wire, "idle after stop")
        Check.eq("stop_unconfirmed", snap.error?.code, "unconfirmed stop is exposed")
        Check.that(r.runtime.adopt(permissionOk = true) == false) { "no resume while the save is unconfirmed" }
        Check.that(r.service.started.size == 1) { "no new service start from a stale save" }
        r.store.failClear = false
        Check.that(r.runtime.adopt(permissionOk = true) == false) { "retry clears, then nothing to resume" }
        Check.eq(null, r.runtime.snapshot().error?.code, "error cleared once the save is confirmed")
        Check.that(!r.store.wanted) { "saved call cleared once the disk accepts" }
      } finally {
        r.close()
      }
    }

    // 22. 通知の切断で保存が消せなければ、失敗として報告し、サービスは止める（成功とはみなさない）
    run {
      val r = Rig(seed = { wanted = true; config = CallSessionConfig("old", "https://example.invalid", "ua", null, "p0") })
      try {
        r.store.failClear = true
        val d = r.runtime.notificationAction(NotificationAction.HANGUP, "old", true)
        Check.eq(false, d.durable, "failed hangup save is reported")
        Check.that(d.stopService) { "service stopped after failed hangup save" }
        Check.that(r.service.stops >= 1) { "service stop requested" }
        Check.that(r.runtime.adopt(permissionOk = true) == false) { "no rejoin after a failed hangup save" }
        Check.that(r.service.started.isEmpty()) { "no service start" }
      } finally {
        r.close()
      }
    }

    // 23. 遅れた古い開始の命令は、新しい通話の前景を作らず、止まった通話も再び前景にしない
    run {
      val r = Rig()
      try {
        Check.that(r.runtime.prepare(args("s1")).ok) { "prepare s1" }
        Check.that(r.runtime.startPrepared("s1").ok) { "start s1" }
        Check.that(r.runtime.stop("s1", "user")) { "stop s1" }
        Check.eq(0L, r.runtime.servicePromoted("s1"), "delayed start after stop makes no foreground")
        Check.that(r.runtime.prepare(args("s2")).ok) { "prepare s2" }
        Check.that(r.runtime.startPrepared("s2").ok) { "start s2" }
        Check.eq(0L, r.runtime.servicePromoted("s1"), "old start does not claim the new session")
        Check.that(r.runtime.servicePromoted("s2") > 0L) { "current start is accepted" }
      } finally {
        r.close()
      }
    }

    // 24. スピーカーミュートの持ち主は再起動をまたいで保たれる。利用者のミュートは残る
    run {
      val r = Rig()
      try {
        join(r, "s1")
        r.runtime.control("s1", NativeCallControlPatch(deafened = true))
        waitUntil("deafen saved with owner") { r.store.muteByDeafen }
        // ミュートにしていなかった → スピーカーミュートがミュートを入れた。再起動の後に外すと、ミュートも外れる
        val r2 = Rig(seed = {
          wanted = true
          config = CallSessionConfig("s1", "https://example.invalid", "ua", null, "p0")
          status = NativeCallStatus(muted = true, deafened = true, device = "smartphone")
          muteByDeafen = true
        })
        try {
          Check.that(r2.runtime.adopt(permissionOk = true)) { "resume" }
          val before = r2.runtime.snapshot()
          Check.that(before.muted && before.deafened && before.muteByDeafen) { "restored deafen state" }
          r2.runtime.control("s1", NativeCallControlPatch(deafened = false))
          val after = r2.runtime.snapshot()
          Check.that(!after.deafened && !after.muted) { "undeafen unmutes the deafen-owned mute after restart" }
        } finally {
          r2.close()
        }
      } finally {
        r.close()
      }
    }

    // 25. 利用者が先にミュートしていたなら、スピーカーミュートを外しても、ミュートは残る（再起動の後も）
    run {
      val r2 = Rig(seed = {
        wanted = true
        config = CallSessionConfig("s1", "https://example.invalid", "ua", null, "p0")
        status = NativeCallStatus(muted = true, deafened = true, device = "smartphone")
        muteByDeafen = false
      })
      try {
        Check.that(r2.runtime.adopt(permissionOk = true)) { "resume" }
        r2.runtime.control("s1", NativeCallControlPatch(deafened = false))
        val after = r2.runtime.snapshot()
        Check.that(!after.deafened && after.muted) { "independently muted stays muted" }
      } finally {
        r2.close()
      }
    }

    // 26. 通知のミュート（エンジンが無い）: 保存を書いてから、正規の再開で戻す。権限が無ければ再開せず、保存は残す
    run {
      val seeded = { store: FakeStore ->
        store.wanted = true
        store.config = CallSessionConfig("S", "https://example.invalid", "ua", null, "p0")
      }
      val r = Rig(seed = { seeded(this) })
      try {
        val d = r.runtime.notificationAction(NotificationAction.DEAFEN, "S", true)
        Check.that(d.accepted && d.resumed && !d.stopService) { "cold deafen resumes the saved call" }
        Check.eq(listOf("S"), r.service.started, "resume through the normal start path")
        Check.that(r.store.status.deafened && r.store.status.muted && r.store.muteByDeafen) { "deafen saved before resume" }
        Check.that(r.store.wanted) { "saved call kept" }
      } finally {
        r.close()
      }
      val r2 = Rig(seed = { seeded(this) })
      try {
        val d = r2.runtime.notificationAction(NotificationAction.MUTE, "S", false)
        Check.that(!d.resumed && d.stopService) { "no resume without the permission" }
        Check.that(!r2.store.wanted) { "permission loss clears the saved call (no later silent retry)" }
        Check.that(r2.service.started.isEmpty()) { "no service start without the permission" }
      } finally {
        r2.close()
      }
    }

    // 27. 通話の持続（スティッキー）の戻り値の決まり: 操作は続け、切断と無効な意図は止める
    run {
      Check.that(NativeCallSticky.keepAfter(NotificationAction.MUTE, isNullIntent = false)) { "mute stays sticky" }
      Check.that(NativeCallSticky.keepAfter(NotificationAction.DEAFEN, isNullIntent = false)) { "deafen stays sticky" }
      Check.that(!NativeCallSticky.keepAfter(NotificationAction.HANGUP, isNullIntent = false)) { "hangup is not sticky" }
      Check.that(NativeCallSticky.keepAfter(null, isNullIntent = true)) { "system restart stays sticky" }
      Check.that(!NativeCallSticky.keepAfter(null, isNullIntent = false)) { "unknown intent is not sticky" }
    }

    // 36. 古い通知・古い開始が来ても、生きている新しい通話の再起動の印（STICKY）を消さない
    run {
      // 古い切断（新しい通話が生きている）→ STICKY。生きていない・有効な切断だけは止まる
      Check.that(NativeCallSticky.keepAfter(NotificationAction.HANGUP, isNullIntent = false, liveCallRemains = true)) { "stale hangup with a live newer call stays sticky" }
      Check.that(!NativeCallSticky.keepAfter(NotificationAction.HANGUP, isNullIntent = false, liveCallRemains = false)) { "hangup with no live call is not sticky" }
      // 古い開始（生きている通話がある）→ 残す。生きている通話が無ければ止める
      Check.that(NativeCallSticky.staleStartKeeps(liveCallRemains = true)) { "stale start keeps the live call" }
      Check.that(!NativeCallSticky.staleStartKeeps(liveCallRemains = false)) { "stale start with no live call stops" }
      // 生きている通話が無いとき、古いミュートだけは従来どおり（通話の操作として STICKY）
      Check.that(NativeCallSticky.keepAfter(NotificationAction.MUTE, isNullIntent = false, liveCallRemains = false)) { "mute keeps the call sticky" }
    }

    // 28. 新しい通話の準備は、古い保存を先に消す（死んでも、古い通話は戻らない）。消せなければ拒否する
    run {
      val r = Rig(seed = { wanted = true; config = CallSessionConfig("X", "https://example.invalid", "ua", null, "pX") })
      try {
        Check.that(r.runtime.prepare(args("Y")).ok) { "prepare Y after clearing X" }
        Check.that(!r.store.wanted) { "old saved call X cleared before Y starts" }
        Check.that(r.service.started.isEmpty()) { "no service on prepare" }
        // 準備の後、Y が参加する前に死んだ（新しいプロセス）。X は戻らない
        val r2 = Rig(seed = { wanted = r.store.wanted; config = r.store.config })
        try {
          Check.that(r2.runtime.adopt(permissionOk = true) == false) { "X never resumes" }
          Check.that(r2.service.started.isEmpty()) { "no X start" }
        } finally {
          r2.close()
        }
      } finally {
        r.close()
      }
      val rf = Rig(seed = { wanted = true; config = CallSessionConfig("X", "https://example.invalid", "ua", null, "pX") })
      try {
        rf.store.failClear = true
        val p = rf.runtime.prepare(args("Y"))
        Check.eq(false, p.ok, "prepare rejected when the old save cannot be cleared")
        Check.eq("persist_failed", p.code, "reason is persist_failed")
        Check.that(rf.service.started.isEmpty() && rf.sockets.made.isEmpty() && rf.audio.runs.isEmpty()) { "nothing starts" }
      } finally {
        rf.close()
      }
    }

    // 29. 古い API の UI の起動は保存を消さない。遅れて来た正当な再起動は、保存された通話を再開する
    run {
      val r = Rig(seed = { wanted = true; config = CallSessionConfig("S", "https://example.invalid", "ua", null, "p0") })
      try {
        Check.eq(false, r.runtime.uiLaunch(sdk = 29, lastExit = null), "older API UI launch clears nothing")
        Check.that(r.store.wanted) { "wanted preserved for the delayed restart" }
        Check.that(r.runtime.adopt(permissionOk = true)) { "legitimate restart resumes S" }
        Check.eq(listOf("S"), r.service.started, "S restarted")
      } finally {
        r.close()
      }
    }

    // 30. 録音中に許可が無くなる（許可の判定が偽）: 次の確認で、保存を消して止める（再接続の繰り返しにしない）
    run {
      var permitted = true
      val r = Rig(micPermitted = { permitted })
      try {
        join(r, "s1")
        permitted = false
        r.timers.runOnce()
        waitUntil("permission loss stops the call") { r.runtime.snapshot().session == null }
        Check.that(!r.store.wanted) { "saved call cleared on permission loss" }
        Check.that(r.service.stops >= 1) { "service stopped on permission loss" }
      } finally {
        r.close()
      }
    }

    // 31. 許可の無い開始: 録音は開かず、保存も残さない（資源を動かさない）
    run {
      val r = Rig(micPermitted = { false })
      try {
        Check.that(r.runtime.prepare(args("s1")).ok) { "prepare" }
        Check.that(r.runtime.startPrepared("s1").ok) { "startPrepared" }
        waitUntil("service start") { r.service.started.contains("s1") }
        r.runtime.servicePromoted("s1")
        val before = r.sockets.made.size
        r.runtime.serviceStarted("s1", true)
        waitUntil("socket for s1") { r.sockets.made.size > before }
        val sock = r.sockets.made.last()
        sock.listener.onFrame(ServerFrame.Hello(meId = "ua", meLoginName = null))
        waitUntil("join sent") { sock.sent().any { it.contains("call.join") } }
        val peer = r.runtime.snapshot().peer ?: throw AssertionError("peer")
        // 参加が届くと録音の段階へ進む。そこで許可を確かめ、無ければ通話を取り消す（録音は作らない）
        sock.listener.onFrame(ServerFrame.CallState(listOf(NativeCallMember(peer, "ua", status))))
        waitUntil("permission checked before recording") { r.runtime.snapshot().session == null }
        Check.that(r.audio.created == 0) { "no recorder without permission" }
        Check.that(!r.store.wanted) { "nothing saved without permission" }
      } finally {
        r.close()
      }
    }

    // 32. 通知の操作（エンジン無し）で許可が無い: 保存は消して止める（残さない）
    run {
      val r = Rig(seed = { wanted = true; config = CallSessionConfig("S", "https://example.invalid", "ua", null, "p0") })
      try {
        val d = r.runtime.notificationAction(NotificationAction.MUTE, "S", false)
        Check.that(!d.resumed && d.stopService && d.durable) { "cold mute without permission stops and clears" }
        Check.that(!r.store.wanted) { "saved call cleared" }
      } finally {
        r.close()
      }
    }

    // 34. 前の録音が解放されないあいだ、新しい録音は開かない（作成も開始も増えない）
    run {
      val r = Rig(audioUnreleased = true)
      try {
        join(r, "s1")
        val beforeCreates = r.audio.created
        r.runtime.stop("s1", "user")
        // 前の録音が解放されない: 次の通話の録音は、作成も開始も行わない（止めた録音は保持したまま）
        // 次の通話は録音の段階まで進むが、古い録音が解放されないので、新しい録音は作られない
        Check.that(r.runtime.prepare(args("s2")).ok) { "prepare s2" }
        Check.that(r.runtime.startPrepared("s2").ok) { "start s2" }
        waitUntil("second call reaches the service start") { r.service.started.contains("s2") }
        r.runtime.servicePromoted("s2")
        val before = r.sockets.made.size
        r.runtime.serviceStarted("s2", true)
        waitUntil("socket for s2") { r.sockets.made.size > before }
        val sock = r.sockets.made.last()
        sock.listener.onFrame(ServerFrame.Hello(meId = "ua", meLoginName = null))
        waitUntil("join sent for s2") { sock.sent().any { it.contains("call.join") } }
        val peer = r.runtime.snapshot().peer ?: throw AssertionError("peer")
        sock.listener.onFrame(ServerFrame.CallState(listOf(NativeCallMember(peer, "ua", status))))
        Thread.sleep(200)
        Check.that(r.audio.created == beforeCreates) { "no new recorder while the old one is unreleased" }
        Check.that(r.audio.runs.sumOf { it.startCount } == 1) { "no second start" }
      } finally {
        r.close()
      }
    }

    // 35. キック（専用の通話の接続で受ける）: 保存は消え、キックの案内が 1 件だけ残る（by は表示用で、ログには出ない）
    run {
      val r = Rig()
      try {
        join(r, "s1")
        val sock = r.sockets.made.last()
        sock.listener.onFrame(ServerFrame.Kicked(by = "kicker"))
        waitUntil("kicked call ends") { r.runtime.snapshot().session == null }
        Check.that(!r.store.wanted) { "saved call cleared on kick" }
        val err = r.runtime.snapshot().error
        Check.eq("kicked", err?.code, "kick error reaches the snapshot")
        Check.eq("kicker", err?.by, "kick error keeps who removed us")
        Check.that(synchronized(r.logs) { r.logs.none { it.contains("kicker") } }) { "kicker id never logged" }
      } finally {
        r.close()
      }
    }

    // 37. 開始中に退出した run が未解放なら、次の通話も新しい録音を作らない。
    run {
      val gate = CountDownLatch(1)
      val r = Rig(startGate = gate, audioUnreleased = true)
      try {
        r.runtime.prepare(args("s1")); r.runtime.startPrepared("s1"); r.runtime.serviceStarted("s1", true)
        waitUntil("first socket") { r.sockets.made.isNotEmpty() }
        r.sockets.made.last().listener.onFrame(ServerFrame.Hello("ua", null))
        waitUntil("first join") { r.sockets.made.last().sent().any { it.contains("call.join") } }
        val firstPeer = r.runtime.snapshot().peer!!
        r.sockets.made.last().listener.onFrame(ServerFrame.CallState(listOf(NativeCallMember(firstPeer, "ua", status))))
        waitUntil("first recording starts initializing") { r.audio.created == 1 && r.audio.runs[0].startCount == 1 }
        Check.that(r.runtime.stop("s1", "user")) { "old session stopped" }
        Check.that(r.audio.runs[0].stopped) { "starting recorder stopped immediately" }
        r.runtime.prepare(args("s2")); r.runtime.startPrepared("s2"); r.runtime.serviceStarted("s2", true)
        gate.countDown()
        waitUntil("second socket") { r.sockets.made.size == 2 }
        val next = r.sockets.made.last()
        next.listener.onFrame(ServerFrame.Hello("ua", null))
        waitUntil("second join") { next.sent().any { it.contains("call.join") } }
        val nextPeer = r.runtime.snapshot().peer!!
        next.listener.onFrame(ServerFrame.CallState(listOf(NativeCallMember(nextPeer, "ua", status))))
        waitUntil("new recording refused safely") { r.runtime.snapshot().phase == NativeCallPhase.IDLE }
        Check.eq(1, r.audio.created, "late old initialization cannot overlap a new recorder")
        Check.that(!r.store.wanted) { "neither unfinished call is armed" }
      } finally { gate.countDown(); r.close() }
    }

    // 38. 別の io 作業が待っていても、停止の成功応答の前に現在の録音を止める。
    run {
      val r = Rig()
      val busy = CountDownLatch(1)
      val release = CountDownLatch(1)
      try {
        join(r, "s1")
        r.io.execute {
          busy.countDown()
          try { release.await(3, TimeUnit.SECONDS) } catch (_: InterruptedException) { Thread.currentThread().interrupt() }
        }
        Check.that(busy.await(3, TimeUnit.SECONDS)) { "io is deliberately occupied" }
        Check.that(r.runtime.stop("s1", "user")) { "stop acknowledged" }
        Check.that(r.audio.runs[0].stopped) { "recording stopped before io becomes available" }
      } finally { release.countDown(); r.close() }
    }

    // 39. 許可の照会と実際の録音の間で拒否されても、再接続を続けず保存を消す。
    run {
      val r = Rig()
      try {
        join(r, "s1")
        r.audio.runs.last().onFailure("permission_lost")
        waitUntil("permission denial stops call") { r.runtime.snapshot().phase == NativeCallPhase.IDLE }
        Check.that(!r.store.wanted) { "audio permission denial clears recovery" }
      } finally { r.close() }
    }

    // 16. 経路の選択が失敗しても、通話は止まらない（既定の経路のまま）
    run {
      val r = Rig()
      try {
        join(r, "s1")
        Check.eq(1, r.route.begins, "route began once")
        r.runtime.stop("s1", "user")
        waitUntil("route released with the session") { r.route.ends == 1 }
      } finally {
        r.close()
      }
    }
  }

  @JvmStatic fun main(args: Array<String>) {
    run()
    println("NativeCallRuntimeTest: ${Check.count} checks passed")
  }
}
