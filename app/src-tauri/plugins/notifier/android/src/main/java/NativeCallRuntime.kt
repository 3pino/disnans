package dev.disnans.notifier

import com.fasterxml.jackson.databind.JsonNode
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

// 実行の中心（純粋な JVM。Android・OkHttp・AudioRecord には依存しない）。
//
// 規則:
// - 状態機械（NativeCallCore）は、制御のスレッド（control の 1 本）でだけ動く。ほかのスレッドからは入力を積むだけ。
// - 効果（命令）の中で新しい入力が生まれても、制御のスレッドの中では再入しない（キューに積んで、後で処理する）。
// - 録音・経路・サービスの通知など時間のかかるものは io のスレッドで行い、結果を制御のスレッドへ戻す。
// - 保存（wanted）は制御のスレッドで同期に書く。停止は、保存が終わってから戻る（ACK）。
// - 通信の応答は「その試み（attempt）」ごとに受け、試みが今のものでなければ捨てる（古い応答は新しい通話に効かない）。
// - 録音のフレームは「その録音（run）」の番号つきで受け、番号が今のもので、送ってよい状態のときだけ送る。

/** 保存先（デバイスでは NativeCallPrefs）。書けたかどうかを返す */
interface NativeCallStore {
  fun read(): CallPersisted
  fun commitGeneration(generation: Long): Boolean
  fun commitSettings(settings: NativeCallSettings): Boolean
  fun commitSession(status: NativeCallStatus, localMuted: Set<String>, muteByDeafen: Boolean): Boolean
  fun commitWanted(config: CallSessionConfig, status: NativeCallStatus, localMuted: Set<String>, muteByDeafen: Boolean): Boolean
  /** 保存された通話（wanted と接続の情報）を消す。書けたら true。書けなかったら false（状態は確かめられない） */
  fun clearWanted(): Boolean
}

/** 通信の 1 回の接続（試み）。デバイスでは NativeCallWire を 1 試みごとに作る */
interface CallSocket {
  /** 失敗は NativeCallProtocolException（コードつき） */
  fun connect(serverUrl: String, devUser: String?)
  fun sendControl(text: String): Boolean
  fun sendAudio(text: String): Boolean
  fun queuedBytes(): Long
  fun close()
  fun cancel()
}

/** 試み（attempt）ごとの受け取り。呼ばれる場所は通信のスレッド（実行の中心が制御のスレッドへ戻す） */
interface CallSocketListener {
  fun onFrame(frame: ServerFrame)
  /** reason は固定のコード（auth_rejected など）。この試みはこれで終わる */
  fun onClosed(reason: String)
}

fun interface CallSocketFactory {
  fun create(listener: CallSocketListener): CallSocket
}

/** 録音と再生の 1 回（run）。start は失敗したらコードを返す（null は成功）。stop は待たない */
interface AudioRun {
  fun start(): String?
  fun setCapture(enabled: Boolean)
  fun setMicVolume(volume: Double)
  fun stop()
  /** 前の run の資源が解放されるまで（上限つき）。io のスレッドで待つ */
  fun awaitReleased(timeoutMs: Long): Boolean
  /** 診断用の数（音・ID は含まない）。既定は空 */
  fun audioCounters(): Map<String, Long> = emptyMap()
}

interface AudioFactory {
  fun preflight(rawInput: Boolean): String?
  fun create(
    rawInput: Boolean,
    micVolume: Double,
    mixer: NativeMixer,
    sender: (seq: Long, pcm: ByteArray) -> Unit,
    onFailure: (code: String) -> Unit,
  ): AudioRun
}

interface RoutePort {
  fun begin()
  fun end()
  /** 選べたかどうか（選べなければ既定の経路のまま） */
  fun select(outputId: String): Boolean
}

interface ServicePort {
  /** フォアグラウンドサービスの開始を頼む。拒否されたら false */
  fun start(session: String): Boolean
  fun stop()
  fun isRunning(): Boolean
  fun refresh(snapshot: NativeCallSnapshot)
}

interface TimerPort {
  fun schedule(delayMs: Long, task: Runnable): () -> Unit
}

interface RuntimeLog {
  fun info(message: String)
  fun warn(message: String)
}

/** 通知のボタン */
enum class NotificationAction { MUTE, DEAFEN, HANGUP }

/** 通知（古いものも含む）の判定の結果 */
data class NotificationDecision(
  /** 今の通話（または保存された通話）に効いたか */
  val accepted: Boolean,
  /** 状態機械へ渡す入力（今の通話に効くもの） */
  val forward: Input?,
  /** 保存された通話の印を先に消す（エンジンが無いとき・切断） */
  val clearWanted: Boolean,
  /** サービスを止めてよいか（効かせるものが無い） */
  val stopService: Boolean,
  /** エンジンが無いときの、保存された通話へのミュート・スピーカーミュート（保存してから、確かめて再開する） */
  val coldControl: NotificationAction? = null,
  /** 保存が確かに書けたか。書けなかったら false（操作は止まり、失敗として報告する） */
  val durable: Boolean = true,
  /** 保存された通話を、この操作の後に再開したか */
  val resumed: Boolean = false,
)

/** スピーカーミュートとミュートの切り替え（状態機械の規則と同じ）。ミュートの持ち主も一緒に返す */
object NativeCallToggles {
  fun mute(st: NativeCallStatus, byDeafen: Boolean): Pair<NativeCallStatus, Boolean> {
    val nextMuted = !st.muted
    var muted = nextMuted
    var deafened = st.deafened
    var owner = byDeafen
    if (!nextMuted && deafened) {
      if (owner) muted = false
      owner = false
      deafened = false
    }
    return st.copy(muted = muted, deafened = deafened) to owner
  }

  fun deafen(st: NativeCallStatus, byDeafen: Boolean): Pair<NativeCallStatus, Boolean> {
    val next = !st.deafened
    var muted = st.muted
    var owner = byDeafen
    if (next && !st.deafened) {
      owner = !st.muted
      muted = true
    } else if (!next && st.deafened) {
      if (owner) muted = false
      owner = false
    }
    return st.copy(muted = muted, deafened = next) to owner
  }
}

/** 通知の判定（通知の意図には通話の ID が入っている。古い通話の通知は効かない） */
object NativeCallIntents {
  fun decide(action: NotificationAction?, intentSession: String?, active: NativeCallSnapshot?, persisted: CallPersisted): NotificationDecision {
    if (action == null || intentSession.isNullOrEmpty()) {
      return NotificationDecision(accepted = false, forward = null, clearWanted = false, stopService = active == null)
    }
    if (active?.session != null) {
      if (active.session != intentSession) return NotificationDecision(false, null, false, stopService = false)
      val forward = when (action) {
        NotificationAction.MUTE -> Input.Control(intentSession, NativeCallControlPatch(muted = !active.muted))
        NotificationAction.DEAFEN -> Input.Control(intentSession, NativeCallControlPatch(deafened = !active.deafened))
        NotificationAction.HANGUP -> Input.Stop(intentSession, "notification_hangup")
      }
      return NotificationDecision(true, forward, clearWanted = false, stopService = false)
    }
    // エンジンが無い（プロセスが作り直された）。保存された通話だけに効かせる
    val matches = persisted.wanted && persisted.config?.session == intentSession
    if (matches && action == NotificationAction.HANGUP) {
      // 切断は、再開より先に保存から消す
      return NotificationDecision(accepted = true, forward = null, clearWanted = true, stopService = true)
    }
    if (matches && (action == NotificationAction.MUTE || action == NotificationAction.DEAFEN)) {
      // ミュートの操作は、保存を書いてから、正規の再開（権限を確かめる）で通話を戻す。通話の権利は消さない
      return NotificationDecision(accepted = true, forward = null, clearWanted = false, stopService = false, coldControl = action)
    }
    return NotificationDecision(accepted = false, forward = null, clearWanted = false, stopService = true)
  }
}

/** UI の起動（プラグインの読み込み）で、保存された wanted を消すかどうかの判定 */
object NativeCallRecovery {
  /** ApplicationExitInfo の REASON_USER_REQUESTED（API 30 以上。強制終了など） */
  const val EXIT_USER_REQUESTED = 10
  /** ApplicationExitInfo の REASON_USER_STOPPED（API 34 以上） */
  const val EXIT_USER_STOPPED = 11
  /** 終了の理由（ApplicationExitInfo）を読める最初の版 */
  const val SDK_EXIT_INFO = 30

  /**
   * UI の起動で、保存された wanted を消してよいか。消すのは、利用者による停止（強制終了）の証拠があるときだけ。
   * 証拠が無い・読めないとき（API 29 以前を含む）は消さない（遅れて来る正当な再起動を壊さないため）。
   * エンジンが動いているときは、消さない。ここではサービスを始めない。
   */
  fun clearWantedOnUiLaunch(sdk: Int, lastExit: Int?, engineRunning: Boolean, wanted: Boolean): Boolean {
    if (!wanted || engineRunning) return false
    if (sdk < SDK_EXIT_INFO) return false
    return lastExit == EXIT_USER_REQUESTED || lastExit == EXIT_USER_STOPPED
  }
}

/**
 * サービスの戻り値（sticky の扱い）。Android は最後の onStartCommand の戻り値で再起動を決めるため、
 * 通話が続くあいだの操作（ミュート・スピーカーミュート・再開）は STICKY のまま。切断と無効な意図だけ止まる。
 */
object NativeCallSticky {
  /**
   * 戻り値の決まり。生きている通話（前景）が残るあいだは、古い意図や遅れた開始でも STICKY を保つ。
   * 残らないときは、通話の操作（ミュート・スピーカーミュート）と再起動だけが STICKY。
   * 有効な切断は、このあとサービスを止める（その停止が優先する）。
   */
  fun keepAfter(action: NotificationAction?, isNullIntent: Boolean, liveCallRemains: Boolean = false): Boolean = when {
    liveCallRemains -> true
    isNullIntent -> true
    action == NotificationAction.MUTE || action == NotificationAction.DEAFEN -> true
    else -> false
  }

  /** 遅れた開始（待っていない通話の開始）の戻り値。生きている通話があれば、そのまま残す */
  fun staleStartKeeps(liveCallRemains: Boolean): Boolean = liveCallRemains
}

class NativeCallRuntime(
  private val store: NativeCallStore,
  private val sockets: CallSocketFactory,
  private val audio: AudioFactory,
  private val route: RoutePort,
  private val service: ServicePort,
  private val timers: TimerPort,
  private val control: ExecutorService,
  private val io: ExecutorService,
  /** 状態と中継の通知。呼ばれるのは制御のスレッド（受け側は別のスレッドへ渡すこと） */
  private val publish: (NativeCallEvent) -> Unit,
  /** マイクの許可がいまあるか（既定は許可。実機では Host が ContextCompat で確かめる） */
  private val micPermitted: () -> Boolean = { true },
  private val log: RuntimeLog,
  peerFactory: () -> String,
  private val callTimeoutMs: Long = 5_000L,
  private val nowMs: () -> Long = System::currentTimeMillis,
) {
  companion object {
    const val CLEAR_TRIES = 3
    const val RELEASE_WAIT_MS = 2_000L
    const val MAX_PENDING_AUDIO = 64
    /** 自分の声の大きさを見直す間隔と、これより古い音量は無音として扱う長さ */
    const val LEVEL_TICK_MS = 100L
    const val LEVEL_FRESH_MS = 200L
    /** 診断（状態と数だけ）を出す間隔 */
    const val DIAG_MS = 5_000L
  }

  private val core = NativeCallCore(peerFactory, store.read().generation)
  // withInitial は API 26 以降。minSdk 24 でも同じ再入ガードを使う。
  private val inControl = object : ThreadLocal<Boolean>() {
    override fun initialValue(): Boolean = false
  }
  private val counters = ConcurrentHashMap<String, Long>()
  private val pendingAudio = AtomicInteger(0)

  // ---- 制御のスレッドだけが触るもの ----
  private var sessionNow: String? = null
  private var attemptSeq = 0L
  private var currentAttempt = 0L
  private var attemptSession: String? = null
  private var socket: CallSocket? = null
  private var runSeq = 0L
  private var currentRun = 0L
  private var runSession: String? = null
  private val runPorts = ConcurrentHashMap<Long, AudioRun>()
  private var audioPort: AudioRun? = null
  @Volatile private var captureWanted = true
  private var micVolume = 1.0
  private val mixer = NativeMixer()
  private val peers = HashSet<String>()
  private var routeHeld = false
  private var serviceRunSeq = 0L
  private var activeServiceRun = 0L
  private var activeServiceSession: String? = null
  /** 自分の声の最後の大きさ（録音の番号つきで受けたもの） */
  private var selfRms = 0.0
  private var selfRmsAt = Long.MIN_VALUE
  private var levelTickArmed = false
  private var diagArmed = false
  /** 保存された通話を消せたか確かめられていない（書けなかった）。true のあいだは再開しない */
  private var savedUnconfirmed = false
  /** 止めたが、まだ解放を確かめていない録音（解放まで、新しい録音は開かない） */
  private val retiring = ArrayList<AudioRun>()
  /** 録音の開始の作業の取り消し番号。取り消されたものは、資源を開かずに終わる */
  private var audioTokenSeq = 0L
  @Volatile private var audioToken = 0L

  // ---- 外からの入り口（呼び出しは制御のスレッドの外から。結果を待つ） ----

  /**
   * 準備（ここで通話の ID を登録する。権限の確認より前。資源は動かさない）。
   * 新しい通話を始める前に、保存されている古い通話（wanted）を必ず消す。消せなければ拒否する（資源は動かさない）。
   */
  fun prepare(start: NativeCallStartArgs): Outcome = call {
    if (core.currentSession() == null && (store.read().wanted || savedUnconfirmed)) {
      if (!clearSaved()) return@call Outcome(false, "persist_failed")
    }
    step(Input.Prepare(start))
  }

  fun startPrepared(session: String): Outcome = call { step(Input.StartPrepared(session)) }

  fun cancelPrepared(session: String, reason: String) {
    call { step(Input.CancelPrepared(session, reason)) }
  }

  /**
   * 停止。戻るのは、保存（wanted=false）を試みた後。後始末（録音・通信・サービス）は必ず行う。
   * 戻り値は、保存を確かに消せたか（ACK）。消せなければ false（成功とはみなさない）。
   */
  fun stop(session: String, reason: String): Boolean = try {
    onControl {
      step(Input.Stop(session, reason))
      if (savedUnconfirmed) clearSaved()
      !savedUnconfirmed
    }
  } catch (e: Exception) {
    log.warn("停止の完了を待てませんでした")
    false
  }

  fun control(session: String, patch: NativeCallControlPatch): Outcome = call { step(Input.Control(session, patch)) }

  fun kick(session: String, peer: String): Outcome = call { step(Input.Kick(session, peer)) }

  fun emit(session: String, name: String, payload: JsonNode): Outcome = call { step(Input.Emit(session, name, payload)) }

  /** 読み取りだけ。何も始めない・止めない。通話が無いときは、保存されている wanted を返す */
  fun snapshot(): NativeCallSnapshot = call {
    val s = core.snapshot()
    val base = if (s.session == null && s.phase == NativeCallPhase.IDLE) s.copy(wanted = store.read().wanted) else s
    val withError = if (savedUnconfirmed && base.error == null) {
      base.copy(error = NativeCallError("stop_unconfirmed", NativeCallMessages.japanese("stop_unconfirmed")))
    } else {
      base
    }
    withError.copy(bufferedBytes = socket?.queuedBytes() ?: 0L)
  }

  /** 出力先の選択（通話が無いときは設定として残す） */
  fun outputSelected(outputId: String?) {
    call {
      val s = core.snapshot().session
      if (s != null) {
        step(Input.Control(s, NativeCallControlPatch(settings = NativeCallSettingsPatch(outputId = OutputIdPatch(outputId)))))
      } else {
        store.commitSettings(store.read().settings.copy(outputId = outputId))
      }
    }
  }

  /** サービスが前景になったときに呼ぶ。返り値はそのサービスの番号（停止のときに使う） */
  fun servicePromoted(session: String): Long = call {
    // 開始を待っている通話だけを受ける（古い開始の命令は、前景を作らない。0 を返す）
    if (!core.awaitingServiceStart(session)) return@call 0L
    serviceRunSeq += 1
    activeServiceRun = serviceRunSeq
    activeServiceSession = session
    serviceRunSeq
  }

  /** 前景にできたか（開始の命令への応答） */
  fun serviceStarted(session: String, ok: Boolean) {
    post { step(Input.ServiceStarted(session, ok)) }
  }

  /** サービスが壊された。自分の番号のときだけ、その通話を止める（新しい通話は止めない） */
  fun serviceDestroyed(run: Long) {
    post {
      if (run != 0L && run == activeServiceRun) {
        val s = activeServiceSession
        activeServiceRun = 0L
        activeServiceSession = null
        if (s != null) step(Input.Stop(s, "service_destroyed"))
      }
    }
  }

  /** システムの再起動（intent が null）。保存された wanted のときだけ再開する。戻り値は再開を始めたか */
  fun adopt(permissionOk: Boolean): Boolean = call { resumeSaved(permissionOk) }

  /** 保存された通話を、正規の再開（権限の確認つき）で戻す。消せなかった保存からは戻さない */
  private fun resumeSaved(permissionOk: Boolean, persistedOverride: CallPersisted? = null): Boolean {
    if (core.currentSession() != null) return true
    if (savedUnconfirmed && !clearSaved()) {
      service.stop()
      return false
    }
    val p = persistedOverride ?: store.read()
    if (!p.wanted || p.config == null) {
      service.stop()
      return false
    }
    step(Input.Adopt(p, permissionOk))
    return core.currentSession() != null
  }

  /** 通知のボタン。古い通知や、通話の無い通知は効かない。保存の失敗は報告する（黙って成功にしない） */
  fun notificationAction(action: NotificationAction?, session: String?, permissionOk: Boolean): NotificationDecision = call {
    val active = core.snapshot().takeIf { it.session != null }
    val persisted = store.read()
    val d = NativeCallIntents.decide(action, session, active, persisted)
    if (d.clearWanted && !clearSaved()) {
      // 保存が消せないときも、切断の後始末（サービスを止める）は行う。成功とはみなさない
      service.stop()
      return@call d.copy(durable = false, stopService = true)
    }
    d.forward?.let { step(it) }
    var result = d
    val cold = d.coldControl
    if (cold != null) {
      val st = persisted.status ?: NativeCallStatus(muted = false, deafened = false, device = null)
      val (next, owner) = if (cold == NotificationAction.MUTE) {
        NativeCallToggles.mute(st, persisted.muteByDeafen)
      } else {
        NativeCallToggles.deafen(st, persisted.muteByDeafen)
      }
      if (!store.commitSession(next, persisted.localMuted, owner)) {
        count("persist.session.failed")
        result = d.copy(durable = false, stopService = true)
      } else if (!permissionOk) {
        // 権限が無いときは再開しない。許可の喪失は取り消しとして扱い、保存された通話も消す（残すと、権限の無いまま戻ろうとする）
        if (!clearSaved()) result = d.copy(durable = false, stopService = true) else result = d.copy(resumed = false, stopService = true)
      } else {
        val resumed = resumeSaved(permissionOk, persisted.copy(status = next, muteByDeafen = owner))
        result = d.copy(resumed = resumed, stopService = !resumed)
      }
    }
    if (result.stopService) service.stop()
    result
  }

  /** WebView の起動。保存された wanted を、強制終了の証拠があるときだけ消す（サービスは始めない） */
  fun uiLaunch(sdk: Int, lastExit: Int?): Boolean = call {
    val running = service.isRunning() || core.currentSession() != null
    val clear = NativeCallRecovery.clearWantedOnUiLaunch(sdk, lastExit, running, store.read().wanted)
    if (clear) clearSaved() else false
  }

  /** 診断用の数（コアと、実行の中心の数を合わせる。音や ID は含まない） */
  fun counters(): Map<String, Long> = call {
    val merged = HashMap<String, Long>(counters)
    for ((k, v) in core.counters) merged.merge(k, v, Long::plus)
    merged.toSortedMap()
  }

  // ---- 実行の土台 ----

  private fun <T> call(block: () -> T): T {
    return try {
      onControl(block)
    } catch (e: java.util.concurrent.TimeoutException) {
      throw IllegalStateException("制御のスレッドが応答しません", e)
    }
  }

  /** 制御のスレッドで実行し、結果を待つ。制御のスレッドの中からは呼べない（再入の防止） */
  private fun <T> onControl(block: () -> T): T {
    check(inControl.get() != true) { "制御のスレッドから同期の呼び出しはできません" }
    val f = CompletableFuture<T>()
    control.execute {
      inControl.set(true)
      try {
        f.complete(block())
      } catch (e: Throwable) {
        f.completeExceptionally(e)
      } finally {
        inControl.set(false)
      }
    }
    return try {
      f.get(callTimeoutMs, TimeUnit.MILLISECONDS)
    } catch (e: java.util.concurrent.ExecutionException) {
      throw (e.cause ?: e)
    }
  }

  /** 制御のスレッドで、順番に実行する（待たない）。効果の中から呼んでも、いまの処理の後に回る */
  private fun post(task: () -> Unit) {
    control.execute {
      inControl.set(true)
      try {
        task()
      } catch (e: Exception) {
        log.warn("内部の処理で問題が起きました（${e.javaClass.simpleName}）")
      } finally {
        inControl.set(false)
      }
    }
  }

  private fun onIo(task: () -> Unit) {
    io.execute {
      try {
        task()
      } catch (e: Exception) {
        log.warn("音・経路の処理で問題が起きました（${e.javaClass.simpleName}）")
      }
    }
  }

  private fun count(key: String) {
    counters.merge(key, 1L, Long::plus)
  }

  /** 状態機械へ入力を渡し、その効果を順に実行する（制御のスレッドの中だけ） */
  private fun step(i: Input): Outcome {
    val s = core.handle(i)
    sessionNow = core.currentSession()
    // 通話が変わった（止まった・別のものになった）ら、いまの録音の番号を無効にする。
    // 録音が始まる途中の停止は、状態機械が録音を動いていると見ていなくても、ここで切り離す。
    if (currentRun != 0L && runSession != sessionNow) stopAudio()
    if (currentRun != 0L) {
      val enabled = !core.snapshot().muted
      if (enabled != captureWanted) {
        captureWanted = enabled
        runPorts[currentRun]?.setCapture(enabled)
      }
    }
    if (sessionNow != null && !diagArmed) {
      diagArmed = true
      timers.schedule(DIAG_MS, Runnable { post { diagTick() } })
    }
    for (f in s.fx) perform(f)
    return s.outcome
  }

  /** 診断: 状態と数だけを 5 秒ごとに。通話が無くなったら止まる */
  private fun diagTick() {
    val s = core.snapshot()
    if (s.session == null) {
      diagArmed = false
      return
    }
    val nums = HashMap<String, Long>(counters)
    for ((k, v) in core.counters) nums.merge(k, v, Long::plus)
    audioPort?.let { p -> for ((k, v) in p.audioCounters()) nums.merge("pump.$k", v, Long::plus) }
    val text = nums.toSortedMap().entries.joinToString(" ") { "${it.key}=${it.value}" }
    log.info("[native-call] 状態=${s.phase.wire} 一覧=${s.listed} 人数=${s.members.size} ミュート=${s.muted} スピーカーミュート=${s.deafened} 数: $text")
    timers.schedule(DIAG_MS, Runnable { post { diagTick() } })
  }

  /** 自分の声の大きさを見直す。音が新しいうちはその大きさ、古ければ無音（上限の判定が止まるように） */
  private fun levelTick() {
    val run = currentRun
    if (run == 0L || audioPort == null) {
      levelTickArmed = false
      return
    }
    // 許可が無くなったら、録音を続けない（保存された通話も消して止める）
    val s0 = sessionNow
    if (s0 != null && !micPermitted()) {
      step(Input.PermissionLost(s0))
      return
    }
    val now = nowMs()
    val rms = if (now - selfRmsAt <= LEVEL_FRESH_MS) selfRms else 0.0
    step(Input.Level(sessionNow ?: return, null, rms, now))
    timers.schedule(LEVEL_TICK_MS, Runnable { post { levelTick() } })
  }

  private fun perform(f: Fx) {
    when (f) {
      is Fx.PersistWanted -> persistWanted(f)
      is Fx.PersistGeneration -> if (!store.commitGeneration(f.generation)) count("persist.generation.failed")
      is Fx.PersistSettings -> if (!store.commitSettings(f.settings)) count("persist.settings.failed")
      is Fx.PersistSession -> if (!store.commitSession(f.status, f.localMuted, f.muteByDeafen)) count("persist.session.failed")
      is Fx.StartService -> if (!service.start(f.session)) post { step(Input.ServiceStarted(f.session, false)) }
      is Fx.StopService -> service.stop()
      is Fx.Preflight -> preflight()
      is Fx.Connect -> connect(f.serverUrl, f.devUser)
      is Fx.CloseSocket -> closeSocket()
      is Fx.Send -> sendControl(f.message)
      is Fx.Timer -> timer(f)
      is Fx.Route -> routeSelect(f.outputId)
      is Fx.ReleaseRoute -> releaseRoute()
      is Fx.StartAudio -> startAudio(f)
      is Fx.StopAudio -> stopAudio()
      is Fx.SetCapture -> setCapture(f.enabled)
      is Fx.SetMicGain -> setMicGain(f.volume)
      is Fx.SetLimit -> mixer.setLimit(f.db)
      is Fx.SetPeerGains -> for ((p, g) in f.gains) mixer.setGain(p, g)
      is Fx.SyncPeers -> syncPeers(f.peers)
      is Fx.PlayFrame -> playFrame(f)
      is Fx.Relay -> publishRelay(f)
      is Fx.Publish -> publishState(f.snapshot)
      is Fx.Report -> log.warn("報告: ${f.code}")
    }
  }

  // ---- 保存 ----

  /**
   * 保存された通話を消す（数回試す）。書けたら true。書けなかったら、保存は確かめられない（savedUnconfirmed）。
   * その間は、再開もせず、新しい通話の準備も、消せるまで拒否する。
   */
  private fun clearSaved(): Boolean {
    for (i in 1..CLEAR_TRIES) {
      if (store.clearWanted()) {
        savedUnconfirmed = false
        return true
      }
    }
    savedUnconfirmed = true
    count("persist.clear.failed")
    log.warn("通話の保存を消せませんでした。次の起動で再開の確認が必要になることがあります")
    return false
  }

  private fun persistWanted(f: Fx.PersistWanted) {
    if (!f.wanted) {
      clearSaved()
      return
    }
    val cfg = f.config ?: return
    if (!core.wantedAttemptCurrent(f.attempt)) return
    val ok = store.commitWanted(cfg, f.status, core.snapshot().localMuted.toSet(), f.muteByDeafen)
    if (!ok) count("persist.wanted.failed")
    post { step(Input.WantedCommitted(cfg.session, f.attempt, ok)) }
  }

  // ---- 通信（試みごとに、応答の持ち主を確かめる） ----

  private fun connect(serverUrl: String, devUser: String?) {
    val s = sessionNow ?: return
    socket?.cancel()
    attemptSeq += 1
    val attempt = attemptSeq
    currentAttempt = attempt
    attemptSession = s
    val sk = sockets.create(AttemptListener(attempt))
    socket = sk
    try {
      sk.connect(serverUrl, devUser)
    } catch (e: NativeCallProtocolException) {
      if (currentAttempt == attempt) currentAttempt = 0L
      post { step(Input.SocketFailed(s, e.code)) }
    }
  }

  private fun closeSocket() {
    currentAttempt = 0L
    val sk = socket ?: return
    socket = null
    sk.close()
  }

  private fun sendControl(m: Outbound) {
    if (currentAttempt == 0L) return
    val text = try {
      when (m) {
        is Outbound.Join -> NativeCallProtocol.join(m.peer, m.status)
        Outbound.Leave -> NativeCallProtocol.leave()
        Outbound.Alive -> NativeCallProtocol.alive()
        is Outbound.Update -> NativeCallProtocol.update(m.status)
        is Outbound.Kick -> NativeCallProtocol.kick(m.peer)
        is Outbound.Emit -> NativeCallProtocol.emit(m.name, m.payload)
      }
    } catch (e: NativeCallProtocolException) {
      count("send.refused.${e.code}")
      return
    }
    val sk = socket ?: return
    if (!sk.sendControl(text)) count("send.control.refused")
  }

  /** 通信の応答。試み（attempt）が今のものでないなら捨てる。今の試みの通話（session）で解釈する */
  private inner class AttemptListener(private val attempt: Long) : CallSocketListener {
    override fun onFrame(frame: ServerFrame) {
      control.execute {
        inControl.set(true)
        try {
          if (attempt == currentAttempt) deliver(frame)
        } catch (e: Exception) {
          log.warn("通信の応答を処理できませんでした（${e.javaClass.simpleName}）")
        } finally {
          inControl.set(false)
        }
      }
    }

    override fun onClosed(reason: String) {
      post {
        if (attempt == currentAttempt) {
          currentAttempt = 0L
          socket = null
          val s = attemptSession
          if (s != null) step(Input.SocketFailed(s, reason))
        }
      }
    }
  }

  private fun deliver(frame: ServerFrame) {
    val s = attemptSession ?: return
    when (frame) {
      is ServerFrame.Hello -> step(Input.Hello(s, frame.meId))
      is ServerFrame.CallState -> step(Input.Members(s, frame.members))
      is ServerFrame.Relay -> step(Input.CallEventIn(s, frame.peer, frame.from, frame.name, frame.payload))
      is ServerFrame.Audio -> step(Input.AudioIn(s, frame.peer, frame.pcm))
      is ServerFrame.DroppedAudio -> count("audio.dropped.${frame.reason}")
      is ServerFrame.Kicked -> step(Input.Kicked(s, frame.by))
      is ServerFrame.Error -> step(Input.ServerError(s, frame.code))
      ServerFrame.Pong, ServerFrame.Other -> Unit
    }
  }

  // ---- 録音・再生（run の番号で、古いものを切り離す） ----

  private fun preflight() {
    val s = sessionNow ?: return
    val raw = core.snapshot().settings.rawInput
    onIo {
      val code = audio.preflight(raw)
      post { step(Input.Preflight(s, code == null, code)) }
    }
  }

  private fun startAudio(f: Fx.StartAudio) {
    val s = sessionNow ?: return
    if (!micPermitted()) {
      step(Input.PermissionLost(s))
      return
    }
    runSeq += 1
    val runId = runSeq
    val previous = audioPort
    audioPort = null
    // 前の録音は、解放を確かめるまで保持する（上限の待ちを越えたら、新しい録音は開かない）
    previous?.let { retire(it) }
    currentRun = runId
    runSession = s
    captureWanted = !f.muted
    micVolume = f.settings.micVolume
    mixer.clear()
    peers.clear()
    if (!routeHeld) {
      routeHeld = true
      onIo { route.begin() }
    }
    val raw = f.settings.rawInput
    val volume = f.settings.micVolume
    val outputId = f.settings.outputId
    audioTokenSeq += 1
    val token = audioTokenSeq
    audioToken = token
    onIo {
      if (audioToken != token) return@onIo // 取り消された開始は、資源を開かない
      if (!retirePrevious()) {
        log.warn("前の音声が解放されないため、新しい録音を始めません")
        post { if (runId == currentRun) step(Input.AudioStarted(s, false, "audio_release_timeout")) }
        return@onIo
      }
      if (audioToken != token) return@onIo
      if (outputId != null && !route.select(outputId)) log.warn("保存された出力先は今は使えないため、既定の経路を使います")
      val port = audio.create(
        rawInput = raw,
        micVolume = volume,
        mixer = mixer,
        sender = { seq, pcm -> sendFromAudio(runId, seq, pcm) },
        onFailure = { code ->
          post {
            if (runId == currentRun) {
              if (code == "permission_lost" || !micPermitted()) step(Input.PermissionLost(s)) else step(Input.AudioFailed(s, code))
            }
          }
        },
      )
      runPorts[runId] = port
      // 作成と登録のあいだに止められていても、録音を開始しない。
      if (audioToken != token) {
        runPorts.remove(runId)
        port.stop()
        retire(port)
        return@onIo
      }
      port.setCapture(captureWanted)
      val code = port.start()
      if (code != null || audioToken != token) {
        runPorts.remove(runId)
        port.stop()
        // 次の io 作業より先に記録する。制御側の遅れた応答を待って、新しい録音と重ねない。
        retire(port)
        if (code != null) post {
          if (runId == currentRun) {
            if (code == "permission_lost" || !micPermitted()) step(Input.PermissionLost(s))
            else step(Input.AudioStarted(s, false, code))
          }
        }
        return@onIo
      }
      post { audioStarted(runId, s) }
    }
  }

  private fun retire(port: AudioRun) = synchronized(retiring) {
    if (!retiring.contains(port)) retiring.add(port)
  }

  /** 止めた録音をすべて解放まで待つ（io のスレッドで）。解放できたら true */
  private fun retirePrevious(): Boolean {
    val todo = synchronized(retiring) { retiring.toList() }
    for (r in todo) {
      r.stop()
      if (!r.awaitReleased(RELEASE_WAIT_MS)) return false
      synchronized(retiring) { retiring.remove(r) }
    }
    return true
  }

  private fun audioStarted(runId: Long, s: String) {
    val port = runPorts.remove(runId) ?: return
    if (runId != currentRun) {
      // もう古い録音（止められたあと・新しい通話になったあと）。資源を片付ける
      port.stop()
      retire(port)
      onIo { retirePrevious() }
      return
    }
    audioPort = port
    if (!captureWanted) onIo { port.setCapture(false) }
    val vol = micVolume
    onIo { port.setMicVolume(vol) }
    step(Input.AudioStarted(s, true, null))
    if (!levelTickArmed) {
      levelTickArmed = true
      timers.schedule(LEVEL_TICK_MS, Runnable { post { levelTick() } })
    }
  }

  private fun stopAudio() {
    // 送る意図を、いまこの場で無効にする（これ以降、古い録音の音は送られない）
    currentRun = 0L
    runSession = null
    audioToken = 0L
    val p = audioPort
    audioPort = null
    // 初期化中の run にも即座に停止を伝える。io の開始完了を待つと、退出の応答後に録音が始まりうる。
    val stopping = runPorts.values.toList() + listOfNotNull(p)
    for (r in stopping) { r.stop(); retire(r) }
    mixer.clear()
    peers.clear()
  }

  private fun setCapture(enabled: Boolean) {
    captureWanted = enabled
    val p = audioPort ?: runPorts[currentRun] ?: return
    p.setCapture(enabled)
  }

  private fun setMicGain(volume: Double) {
    micVolume = volume
    val p = audioPort ?: return
    onIo { p.setMicVolume(volume) }
  }

  private fun playFrame(f: Fx.PlayFrame) {
    if (audioPort == null) return
    val samples = NativePcm.leToShorts(f.pcm)
    val r = mixer.accept(f.peer, samples)
    if (r != NativeMixer.Accept.ACCEPTED) count("play.${r.name.lowercase()}")
    // 相手の声の大きさ（話している表示）。状態機械は別の入力として扱う（効果の中では再入しない）
    val s = sessionNow ?: return
    val rms = NativePcm.rms(NativePcm.int16ToFloat(samples))
    val now = nowMs()
    post { step(Input.Level(s, f.peer, rms, now)) }
  }

  private fun syncPeers(next: Set<String>) {
    for (p in peers - next) mixer.removePeer(p)
    for (p in next - peers) mixer.addPeer(p)
    peers.clear()
    peers.addAll(next)
  }

  /** マイクのスレッドから呼ぶ。録音の番号と、送ってよい状態は制御のスレッドで確かめる */
  private fun sendFromAudio(runId: Long, seq: Long, pcm: ByteArray) {
    if (pendingAudio.incrementAndGet() > MAX_PENDING_AUDIO) {
      pendingAudio.decrementAndGet()
      count("audio.queue_full")
      return
    }
    // 自分の声の大きさは、この録音の音から（マイクのスレッドで計算し、制御のスレッドへ渡す）
    val rms = NativePcm.rms(NativePcm.int16ToFloat(NativePcm.leToShorts(pcm)))
    control.execute {
      inControl.set(true)
      try {
        if (runId == currentRun) {
          selfRms = rms
          selfRmsAt = nowMs()
          if (sessionNow != null) step(Input.Level(sessionNow!!, null, rms, selfRmsAt))
        }
        if (runId == currentRun && core.canSendAudio() && currentAttempt != 0L) {
          val sk = socket
          if (sk != null) {
            val text = NativeCallProtocol.audio(seq, pcm)
            count(if (sk.sendAudio(text)) "audio.sent" else "audio.dropped.socket")
          }
        } else {
          count("audio.dropped.stale")
        }
      } catch (e: NativeCallProtocolException) {
        count("audio.refused")
      } finally {
        pendingAudio.decrementAndGet()
        inControl.set(false)
      }
    }
  }

  private fun routeSelect(outputId: String?) {
    if (!routeHeld || outputId == null) return
    onIo { if (!route.select(outputId)) log.warn("保存された出力先は今は使えないため、既定の経路を使います") }
  }

  private fun releaseRoute() {
    if (!routeHeld) return
    routeHeld = false
    onIo { route.end() }
  }

  // ---- 時計・画面 ----

  private fun timer(f: Fx.Timer) {
    val s = sessionNow ?: return
    timers.schedule(f.delayMs, Runnable { post { step(Input.Timer(s, f.key, f.token)) } })
  }

  private fun publishRelay(f: Fx.Relay) {
    val snap = core.snapshot()
    val session = snap.session ?: return
    publish(NativeCallEvent.Relay(NativeCallRelay(session, snap.generation, f.seq, f.peer, f.from, f.name, f.payload)))
  }

  private fun publishState(s: NativeCallSnapshot) {
    val out = s.copy(bufferedBytes = socket?.queuedBytes() ?: 0L)
    publish(NativeCallEvent.State(out))
    onIo { service.refresh(out) }
  }
}
