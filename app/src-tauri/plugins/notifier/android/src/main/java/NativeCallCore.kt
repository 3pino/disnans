package dev.disnans.notifier

import com.fasterxml.jackson.databind.JsonNode

/**
 * ネイティブの通話の状態機械（Android に依存しない）。
 * 入力（呼び出し・サービス・通信・時計）から、次の状態と「やること」（Fx）を決める。
 * 実行はアダプター（NativeCallService）が行う。すべての入力は 1 本の制御のスレッドから呼ぶこと。
 *
 * 規則（docs/design/android-call.md）:
 * - 通話への参加は、サーバーの一覧に自分が載り、音声が始まってから `wanted` を保存する。失敗した初回は再試行しない。
 * - 停止（明示・通知・キック・権限の失効）は、`wanted` を先に消してから後始末をする。
 * - `wanted` のあいだは、切れたら 1・2・4・8・16・30 秒（上限 30 秒）で再接続する。期限（TTL）は無い。
 * - 音声は、切れているあいだは送らず、溜めない。つながって一覧に載ったあと、もう一度始める。
 */

enum class CallPhase { IDLE, PREPARING, STARTING, JOINING, JOINED, RECOVERING, STOPPING }

/** この通話の接続の識別（セッションの一部）。ログには出さない */
data class CallSessionConfig(val session: String, val serverUrl: String, val expectedUserId: String, val devUser: String?, val peer: String)

/** 保存されている状態（再起動のときに読む）。wanted が false なら何も始めない */
data class CallPersisted(
  val wanted: Boolean,
  val config: CallSessionConfig?,
  val settings: NativeCallSettings,
  val status: NativeCallStatus?,
  val localMuted: Set<String>,
  val generation: Long,
  /** スピーカーミュートが入れたミュートか（外すときに、利用者のミュートは残すため。再起動をまたいで保つ） */
  val muteByDeafen: Boolean = false,
)

/** サーバーへ送るもの（実際の JSON は通信の層が作る） */
sealed class Outbound {
  data class Join(val peer: String, val status: NativeCallStatus) : Outbound()
  object Leave : Outbound()
  object Alive : Outbound()
  data class Update(val status: NativeCallStatus) : Outbound()
  data class Kick(val peer: String) : Outbound()
  data class Emit(val name: String, val payload: JsonNode) : Outbound()
}

/** 実行する命令。順番どおりに実行すること（PersistWanted は同期に保存する） */
sealed class Fx {
  /** attempt: 初回の参加の保存の番号（停止で無効になる）。停止の保存は 0 */
  data class PersistWanted(
    val wanted: Boolean,
    val config: CallSessionConfig?,
    val status: NativeCallStatus,
    val attempt: Long = 0L,
    val muteByDeafen: Boolean = false,
  ) : Fx()
  data class PersistGeneration(val generation: Long) : Fx()
  data class PersistSettings(val settings: NativeCallSettings) : Fx()
  data class PersistSession(val status: NativeCallStatus, val localMuted: Set<String>, val muteByDeafen: Boolean = false) : Fx()
  object Preflight : Fx()
  data class StartService(val session: String) : Fx()
  data class StopService(val reason: String) : Fx()
  data class StartAudio(val settings: NativeCallSettings, val muted: Boolean, val deafened: Boolean) : Fx()
  object StopAudio : Fx()
  data class SetCapture(val enabled: Boolean) : Fx()
  data class SetMicGain(val volume: Double) : Fx()
  data class SetLimit(val db: Double?) : Fx()
  data class SetPeerGains(val gains: Map<String, Double>) : Fx()
  data class SyncPeers(val peers: Set<String>) : Fx()
  class PlayFrame(val peer: String, val pcm: ByteArray) : Fx()
  data class Connect(val serverUrl: String, val devUser: String?) : Fx()
  data class CloseSocket(val reason: String) : Fx()
  data class Send(val message: Outbound) : Fx()
  data class Timer(val key: TimerKey, val delayMs: Long, val token: Long) : Fx()
  data class Route(val outputId: String?) : Fx()
  object ReleaseRoute : Fx()
  data class Report(val code: String) : Fx()
  /** seq: 状態と同じ一つの番号の列（世代の中で増える） */
  data class Relay(val peer: String, val from: String, val name: String, val payload: JsonNode, val seq: Long) : Fx()
  data class Publish(val snapshot: NativeCallSnapshot) : Fx()
}

enum class TimerKey { CONNECT, LISTED, ALIVE, RETRY }

/** 命令の結果（同期の呼び出しに返す）。ok が false なら code で理由を言う */
data class Outcome(val ok: Boolean, val code: String? = null)

/** 1 回の入力の結果 */
class Step(val outcome: Outcome, val fx: List<Fx>)

/** 通信・サービス・時計からの入力。session は、その入力が属する通話（古いものは無視する） */
sealed class Input {
  data class Prepare(val request: NativeCallStartArgs) : Input()
  data class StartPrepared(val session: String) : Input()
  data class CancelPrepared(val session: String, val reason: String) : Input()
  /** 明示の停止。session が null なら今の通話 */
  data class Stop(val session: String?, val reason: String) : Input()
  /** システムの再起動（intent が null）。保存された状態から、wanted のときだけ再開する */
  data class Adopt(val persisted: CallPersisted?, val permissionOk: Boolean) : Input()
  data class Control(val session: String, val patch: NativeCallControlPatch) : Input()
  data class Kick(val session: String, val peer: String) : Input()
  data class Emit(val session: String, val name: String, val payload: JsonNode) : Input()
  data class ServiceStarted(val session: String, val ok: Boolean) : Input()
  data class Preflight(val session: String, val ok: Boolean, val code: String?) : Input()
  data class Hello(val session: String, val userId: String) : Input()
  data class SocketFailed(val session: String, val reason: String) : Input()
  data class Members(val session: String, val members: List<NativeCallMember>) : Input()
  data class ServerError(val session: String, val code: String) : Input()
  /** 通話から外された。by は外した人の利用者 ID（案内の表示だけに使う。ログには出さない） */
  data class Kicked(val session: String, val by: String? = null) : Input()
  data class CallEventIn(val session: String, val peer: String, val from: String, val name: String, val payload: JsonNode) : Input()
  class AudioIn(val session: String, val peer: String, val pcm: ByteArray) : Input()
  data class AudioStarted(val session: String, val ok: Boolean, val code: String?) : Input()
  data class AudioFailed(val session: String, val reason: String) : Input()
  data class PermissionLost(val session: String) : Input()
  /** 保存の結果（初回の参加の wanted=true）。attempt が今の番号と違えば無視する */
  data class WantedCommitted(val session: String, val attempt: Long, val ok: Boolean) : Input()
  data class Timer(val session: String, val key: TimerKey, val token: Long) : Input()
  /** 音量（RMS）。peer が null なら自分の声 */
  data class Level(val session: String, val peer: String?, val rms: Double, val nowMs: Long) : Input()
}

/**
 * 状態機械の本体。peer（この通話の接続の ID）は newPeer で作る。
 * 同じ論理的な通話のあいだは同じ peer を使う（再起動・再接続のとき）。ただし peer_in_use のときは 1 回だけ作り直す。
 */
class NativeCallCore(private val newPeer: () -> String, initialGeneration: Long = 0L) {
  companion object {
    const val CONNECT_MS = 10_000L
    const val LISTED_MS = 3_000L
    const val ALIVE_MS = 5_000L
    val RETRY_MS = longArrayOf(1_000, 2_000, 4_000, 8_000, 16_000, 30_000)
    const val MAX_PAYLOAD_BYTES = 64 * 1024
    const val MAX_NAME_CHARS = 64
    /** 声を「しゃべっている」と見る音量（RMS）と、そのあと光らせ続ける時間（pure.ts と同じ） */
    const val SPEAK_THRESHOLD = 0.02
    const val SPEAK_HOLD_MS = 350L
    /** 再試行しても直らない切断の理由（設定や認証の誤り） */
    val FATAL_SOCKET = setOf("auth_rejected", "bad_server_url", "bad_dev_user")
  }

  private var phase = CallPhase.IDLE
  private var session: String? = null
  /** 世代（保存された世代から始まる。新しい開始は必ず大きくなる） */
  private var generation = initialGeneration
  /** 状態と中継の共通の番号（世代が変わると 0 に戻る。世代と合わせて順序を決める） */
  private var seq = 0L
  private var config: CallSessionConfig? = null
  private var peer: String? = null
  private var wanted = false
  private var members: List<NativeCallMember> = emptyList()
  private var listed = false
  private var linkUp = false
  private var audioRunning = false
  private var muted = false
  private var deafened = false
  private var muteByDeafen = false
  private val localMuted = LinkedHashSet<String>()
  private val speakState = HashMap<String, SpeakState>()
  private val speaking = HashMap<String, Boolean>()
  private var settings = NativeCallSettings(micVolume = 1.0, outVolume = 1.0, limiter = true, limitDb = NativePcm.LIMIT_DB_DEFAULT, rawInput = false, outputId = null)
  private var device: String? = null
  private var error: NativeCallError? = null
  private var autoRejoinUsed = false
  private var peerRegenerated = false
  private var retryIndex = 0
  /** 保存の待ちの番号（0 は無し）。停止・再接続で 0 に戻す */
  private var pendingWanted = 0L
  private var attemptSeq = 0L
  private val tokens = HashMap<TimerKey, Long>()
  private var fx = ArrayList<Fx>()
  private var changed = false

  private fun nextSeq(): Long {
    seq += 1
    return seq
  }

  private fun newGeneration(g: Long) {
    generation = g
    seq = 0L
  }

  /** 音の送信を許してよいか（録音の中でも、参加して一覧に載り、ミュートでないとき） */
  fun canSendAudio(): Boolean = phase == CallPhase.JOINED && listed && !muted && audioRunning

  /** この通話のサービスの開始を待っているか（開始の命令への応答の確かめ） */
  fun awaitingServiceStart(session: String): Boolean = session == this.session && phase == CallPhase.STARTING

  /** 通話の ID（無ければ null）。通信の層が、受け取った入力がどの通話のものかを見るのに使う */
  fun currentSession(): String? = session

  /** 受けた・捨てた・鳴らした音の数（診断用。音の中身は持たない） */
  val counters = sortedMapOf<String, Long>()

  private class SpeakState(var lastLoud: Long = 0L, var speaking: Boolean = false)

  /** 状態の読み取り（何も始めない・止めない）。bufferedBytes は通信の層が後から入れる */
  fun snapshot(): NativeCallSnapshot = NativeCallSnapshot(
    session = session,
    generation = generation,
    seq = seq,
    wanted = wanted,
    phase = wirePhase(phase),
    serverUrl = config?.serverUrl,
    peer = peer,
    members = members,
    muted = muted,
    deafened = deafened,
    muteByDeafen = muteByDeafen,
    speaking = speaking.toMap(),
    localMuted = localMuted.toList(),
    settings = settings,
    linkUp = linkUp,
    listed = listed,
    bufferedBytes = 0L,
    error = error,
  )

  /** 画面に出す段階（準備中と開始中は「参加中」にまとめる） */
  private fun wirePhase(p: CallPhase): NativeCallPhase = when (p) {
    CallPhase.IDLE -> NativeCallPhase.IDLE
    CallPhase.PREPARING, CallPhase.STARTING, CallPhase.JOINING -> NativeCallPhase.JOINING
    CallPhase.JOINED -> NativeCallPhase.JOINED
    CallPhase.RECOVERING -> NativeCallPhase.RECOVERING
    CallPhase.STOPPING -> NativeCallPhase.STOPPING
  }

  fun handle(input: Input): Step {
    fx = ArrayList()
    val outcome = when (input) {
      is Input.Prepare -> prepare(input.request)
      is Input.StartPrepared -> startPrepared(input.session)
      is Input.CancelPrepared -> stopIf(input.session, "cancelled:${input.reason}")
      is Input.Stop -> stopIf(input.session, input.reason)
      is Input.Adopt -> adopt(input.persisted, input.permissionOk)
      is Input.Control -> control(input.session, input.patch)
      is Input.Kick -> kick(input.session, input.peer)
      is Input.Emit -> emit(input.session, input.name, input.payload)
      is Input.ServiceStarted -> { serviceStarted(input.session, input.ok); null }
      is Input.Preflight -> { preflight(input.session, input.ok, input.code); null }
      is Input.Hello -> { hello(input.session, input.userId); null }
      is Input.SocketFailed -> { socketLost(input.session, input.reason); null }
      is Input.Members -> { onMembers(input.session, input.members); null }
      is Input.ServerError -> { serverError(input.session, input.code); null }
      is Input.Kicked -> {
        if (isCurrent(input.session)) {
          error = NativeCallError("kicked", NativeCallMessages.japanese("kicked"), input.by)
          stop(null, "kicked")
        }
        null
      }
      is Input.CallEventIn -> { callEvent(input.session, input.peer, input.from, input.name, input.payload); null }
      is Input.AudioIn -> { audio(input.session, input.peer, input.pcm); null }
      is Input.AudioStarted -> { audioStarted(input.session, input.ok, input.code); null }
      is Input.AudioFailed -> { audioFailed(input.session, input.reason); null }
      is Input.PermissionLost -> { if (isCurrent(input.session)) stop(null, "permission_lost"); null }
      is Input.WantedCommitted -> { wantedCommitted(input.session, input.attempt, input.ok); null }
      is Input.Timer -> { timer(input.session, input.key, input.token); null }
      is Input.Level -> { level(input.session, input.peer, input.rms, input.nowMs); null }
    } ?: Outcome(true)
    if (changed) {
      changed = false
      val n = nextSeq()
      fx.add(Fx.Publish(snapshot().copy(seq = n)))
    }
    return Step(outcome, fx)
  }

  // ---- 開始 ----

  private fun prepare(r: NativeCallStartArgs): Outcome {
    if (phase != CallPhase.IDLE) return Outcome(false, "busy")
    session = r.session
    config = null
    peer = newPeer()
    wanted = false
    members = emptyList()
    listed = false
    linkUp = false
    audioRunning = false
    muted = r.status.muted
    deafened = r.status.deafened
    device = r.status.device
    muteByDeafen = false
    localMuted.clear()
    localMuted.addAll(r.localMuted)
    settings = r.settings
    error = null
    autoRejoinUsed = false
    peerRegenerated = false
    retryIndex = 0
    newGeneration(generation + 1)
    fx.add(Fx.PersistGeneration(generation))
    phase = CallPhase.PREPARING
    changed = true
    config = CallSessionConfig(r.session, r.serverUrl, r.expectedUserId, r.devUser, peer!!)
    fx.add(Fx.PersistSettings(settings))
    return Outcome(true)
  }

  private fun startPrepared(s: String): Outcome {
    if (phase != CallPhase.PREPARING || s != session) return Outcome(false, "stale")
    phase = CallPhase.STARTING
    changed = true
    fx.add(Fx.StartService(s))
    return Outcome(true)
  }

  private fun serviceStarted(s: String, ok: Boolean) {
    if (!isCurrent(s) || phase != CallPhase.STARTING) return
    if (!ok) return fail("service_failed")
    fx.add(Fx.Preflight)
  }

  private fun preflight(s: String, ok: Boolean, code: String?) {
    if (!isCurrent(s) || phase != CallPhase.STARTING) return
    if (!ok) return fail(code ?: "audio_unavailable")
    phase = if (wanted) CallPhase.RECOVERING else CallPhase.JOINING
    changed = true
    connect()
  }

  private fun connect() {
    val c = config ?: return fail("no_config")
    fx.add(Fx.Connect(c.serverUrl, c.devUser))
    arm(TimerKey.CONNECT, CONNECT_MS)
  }

  // ---- 再起動（intent が null のとき） ----

  private fun adopt(p: CallPersisted?, permissionOk: Boolean): Outcome? {
    if (phase != CallPhase.IDLE) return null
    val c = p?.config
    if (p == null || !p.wanted || c == null) {
      fx.add(Fx.StopService("no_wanted"))
      return null
    }
    if (!permissionOk) {
      fx.add(Fx.PersistWanted(false, null, status()))
      fx.add(Fx.StopService("permission_lost"))
      return null
    }
    session = c.session
    config = c
    peer = c.peer
    settings = p.settings
    localMuted.clear()
    localMuted.addAll(p.localMuted)
    p.status?.let {
      muted = it.muted
      deafened = it.deafened
      device = it.device
    }
    // 再起動をまたいでも、スピーカーミュートが入れたミュートだと分かるように保つ
    muteByDeafen = p.muteByDeafen
    newGeneration(maxOf(generation, p.generation) + 1)
    fx.add(Fx.PersistGeneration(generation))
    wanted = true
    members = emptyList()
    listed = false
    linkUp = false
    audioRunning = false
    error = null
    autoRejoinUsed = false
    peerRegenerated = false
    retryIndex = 0
    phase = CallPhase.STARTING
    changed = true
    fx.add(Fx.StartService(c.session))
    return null
  }

  // ---- 参加の手順（つながる → 挨拶 → 参加 → 一覧 → 音声 → 保存） ----

  private fun hello(s: String, userId: String) {
    if (!isCurrent(s)) return
    val c = config ?: return
    if (userId != c.expectedUserId) return fail("identity_mismatch")
    if (phase != CallPhase.JOINING && phase != CallPhase.RECOVERING && phase != CallPhase.JOINED) return
    cancel(TimerKey.CONNECT)
    linkUp = true
    if (phase == CallPhase.JOINED) {
      listed = false
      stopAudioFx()
      phase = CallPhase.RECOVERING
      changed = true
    }
    fx.add(Fx.Send(Outbound.Join(peer!!, status())))
    arm(TimerKey.LISTED, LISTED_MS)
  }

  private fun onMembers(s: String, list: List<NativeCallMember>) {
    if (!isCurrent(s) || phase == CallPhase.IDLE || phase == CallPhase.STOPPING || phase == CallPhase.PREPARING || phase == CallPhase.STARTING) return
    members = list
    val me = list.firstOrNull { it.peer == peer }
    val mine = me != null && me.userId == config?.expectedUserId
    if (mine) {
      if (!listed) {
        listed = true
        cancel(TimerKey.LISTED)
        changed = true
        if (!audioRunning) fx.add(Fx.StartAudio(settings, muted, deafened))
      }
      fx.add(Fx.SyncPeers(list.filter { it.peer != peer }.map { it.peer }.toSet()))
      return
    }
    if (listed) {
      // 一覧から外された（見回り・接続の入れ替え）。一度だけ入り直す。二度目は止める
      listed = false
      stopAudioFx()
      fx.add(Fx.SyncPeers(emptySet()))
      if (!autoRejoinUsed) {
        autoRejoinUsed = true
        phase = CallPhase.RECOVERING
        changed = true
        fx.add(Fx.Send(Outbound.Join(peer!!, status())))
        arm(TimerKey.LISTED, LISTED_MS)
      } else {
        stop(null, "server_removed")
      }
    }
  }

  private fun audioStarted(s: String, ok: Boolean, code: String?) {
    if (!isCurrent(s) || (phase != CallPhase.JOINING && phase != CallPhase.RECOVERING && phase != CallPhase.JOINED)) return
    if (!ok) return if (wanted) enterRecovery(code ?: "audio_failed") else fail(code ?: "audio_failed")
    audioRunning = true
    if (phase == CallPhase.JOINED) return
    // 再起動の再開は、保存済みの wanted のまま。初回の参加は、保存が終わるまで「参加済み」にしない
    if (wanted) return enterJoined()
    if (pendingWanted != 0L) return
    attemptSeq += 1
    pendingWanted = attemptSeq
    fx.add(Fx.PersistWanted(true, config, status(), pendingWanted, muteByDeafen))
  }

  /** 保存の結果。番号が今のものと違う（停止・再接続のあとの遅れた結果）は無視する */
  private fun wantedCommitted(s: String, attempt: Long, ok: Boolean) {
    if (!isCurrent(s) || attempt == 0L || attempt != pendingWanted) return
    pendingWanted = 0L
    if (!ok) return fail("persist_failed")
    wanted = true
    enterJoined()
  }

  private fun enterJoined() {
    phase = CallPhase.JOINED
    error = null
    retryIndex = 0
    cancel(TimerKey.RETRY)
    changed = true
    arm(TimerKey.ALIVE, ALIVE_MS)
  }

  /** この保存の番号がまだ有効か（保存を実行する直前に、呼ぶ側が確かめる） */
  fun wantedAttemptCurrent(attempt: Long): Boolean = attempt != 0L && attempt == pendingWanted && session != null

  private fun audioFailed(s: String, reason: String) {
    if (!isCurrent(s) || phase == CallPhase.IDLE || phase == CallPhase.STOPPING) return
    if (wanted) enterRecovery("audio_$reason") else fail("audio_$reason")
  }


  // ---- 切れたとき・再接続 ----

  private fun socketLost(s: String, reason: String) {
    if (!isCurrent(s) || phase == CallPhase.IDLE || phase == CallPhase.STOPPING || phase == CallPhase.PREPARING || phase == CallPhase.STARTING) return
    // 認証の拒否（401・403）と、設定の誤り（URL・ID）は、待っても直らないので再試行しない
    if (wanted && reason !in FATAL_SOCKET) enterRecovery(reason) else fail(reason)
  }

  private fun enterRecovery(reason: String) {
    phase = CallPhase.RECOVERING
    pendingWanted = 0L
    listed = false
    linkUp = false
    members = emptyList()
    stopAudioFx()
    fx.add(Fx.SyncPeers(emptySet()))
    fx.add(Fx.CloseSocket(reason))
    cancel(TimerKey.CONNECT)
    cancel(TimerKey.LISTED)
    cancel(TimerKey.ALIVE)
    error = NativeCallError(reason, NativeCallMessages.japanese(reason))
    val delay = RETRY_MS[minOf(retryIndex, RETRY_MS.size - 1)]
    retryIndex += 1
    arm(TimerKey.RETRY, delay)
    changed = true
  }

  private fun serverError(s: String, code: String) {
    if (!isCurrent(s) || phase == CallPhase.IDLE) return
    if (code == "peer_in_use" && (phase == CallPhase.JOINING || phase == CallPhase.RECOVERING || phase == CallPhase.JOINED) && !peerRegenerated) {
      // 古い接続がまだサーバーに残っている。この通話の peer を一度だけ作り直して入り直す
      peerRegenerated = true
      peer = newPeer()
      config = config?.copy(peer = peer!!)
      listed = false
      fx.add(Fx.Send(Outbound.Join(peer!!, status())))
      arm(TimerKey.LISTED, LISTED_MS)
      changed = true
      return
    }
    if (code == "not_in_call") {
      if (listed) onMembers(s, members.filter { it.peer != peer })
      return
    }
    if (!listed && (phase == CallPhase.JOINING || phase == CallPhase.RECOVERING)) {
      if (wanted) enterRecovery(code) else fail(code)
      return
    }
    fx.add(Fx.Report(code))
  }

  private fun timer(s: String, key: TimerKey, token: Long) {
    if (!isCurrent(s) || tokens[key] != token) return
    tokens.remove(key)
    when (key) {
      TimerKey.CONNECT -> if (!linkUp) {
        if (wanted) enterRecovery("connect_timeout") else fail("connect_timeout")
      }
      TimerKey.LISTED -> if (!listed) {
        if (wanted) enterRecovery("join_timeout") else fail("join_timeout")
      }
      TimerKey.ALIVE -> if (phase == CallPhase.JOINED && listed) {
        fx.add(Fx.Send(Outbound.Alive))
        arm(TimerKey.ALIVE, ALIVE_MS)
      }
      TimerKey.RETRY -> if (phase == CallPhase.RECOVERING && wanted) connect()
    }
  }

  // ---- 操作（ミュート・音量・キック・送信） ----

  private fun control(s: String, p: NativeCallControlPatch): Outcome {
    if (!isCurrent(s) || phase == CallPhase.IDLE || phase == CallPhase.STOPPING) return Outcome(false, "no_session")
    p.settings?.let { applySettingsPatch(it) }
    p.peerMute?.let { pm ->
      if (pm.muted) localMuted.add(pm.peer) else localMuted.remove(pm.peer)
      fx.add(Fx.PersistSession(status(), localMuted.toSet(), muteByDeafen))
      refreshGains()
      changed = true
    }
    p.deafened?.let { if (it != deafened) setDeafened(it) }
    p.muted?.let { if (it != muted) setMuted(it) }
    return Outcome(true)
  }

  private fun setMuted(v: Boolean) {
    muted = v
    // ミュートを外したら、スピーカーミュートも外す（ミュートなしでスピーカーミュートにはしない）
    if (!v && deafened) setDeafened(false)
    applyMute()
  }

  private fun setDeafened(on: Boolean) {
    if (on && !deafened) {
      muteByDeafen = !muted
      muted = true
    } else if (!on && deafened) {
      if (muteByDeafen) muted = false
      muteByDeafen = false
    }
    deafened = on
    refreshGains()
    applyMute()
  }

  private fun applyMute() {
    if (audioRunning) fx.add(Fx.SetCapture(!muted))
    if (listed) fx.add(Fx.Send(Outbound.Update(status())))
    fx.add(Fx.PersistSession(status(), localMuted.toSet(), muteByDeafen))
    changed = true
  }

  /** 部分の変更を、今の設定に重ねる（数は範囲に収める。JS の範囲と同じ） */
  private fun applySettingsPatch(p: NativeCallSettingsPatch) {
    val cur = settings
    applySettings(
      NativeCallSettings(
        micVolume = p.micVolume?.let { NativePcm.clampVolume(it, NativePcm.MIC_VOLUME_MAX) } ?: cur.micVolume,
        outVolume = p.outVolume?.let { NativePcm.clampVolume(it, NativePcm.OUT_VOLUME_MAX) } ?: cur.outVolume,
        limiter = p.limiter ?: cur.limiter,
        limitDb = p.limitDb?.let { NativePcm.clampLimitDb(it) } ?: cur.limitDb,
        rawInput = p.rawInput ?: cur.rawInput,
        outputId = p.outputId?.value ?: if (p.outputId != null) null else cur.outputId,
      ),
    )
  }

  private fun applySettings(v: NativeCallSettings) {
    val raw = settings.rawInput != v.rawInput
    settings = v
    fx.add(Fx.PersistSettings(v))
    fx.add(Fx.SetMicGain(v.micVolume))
    fx.add(Fx.SetLimit(if (v.limiter) v.limitDb else null))
    refreshGains()
    if (v.outputId != null) fx.add(Fx.Route(v.outputId))
    if (raw && audioRunning) {
      fx.add(Fx.StopAudio)
      fx.add(Fx.StartAudio(settings, muted, deafened))
    }
    changed = true
  }

  private fun refreshGains() {
    val out = if (deafened) 0.0 else settings.outVolume
    val gains = HashMap<String, Double>()
    for (m in members) if (m.peer != peer) gains[m.peer] = if (deafened || localMuted.contains(m.peer)) 0.0 else out
    fx.add(Fx.SetPeerGains(gains))
  }

  private fun kick(s: String, peerId: String): Outcome {
    if (!isCurrent(s)) return Outcome(false, "no_session")
    if (!listed) return Outcome(false, "not_listed")
    fx.add(Fx.Send(Outbound.Kick(peerId)))
    return Outcome(true)
  }

  private fun emit(s: String, name: String, payload: JsonNode): Outcome {
    if (!isCurrent(s)) return Outcome(false, "no_session")
    if (!listed || phase != CallPhase.JOINED) return Outcome(false, "not_joined")
    if (name.isEmpty() || name.length > MAX_NAME_CHARS || name == "audio") return Outcome(false, "bad_name")
    if (payload.toString().toByteArray(Charsets.UTF_8).size > MAX_PAYLOAD_BYTES) return Outcome(false, "too_large")
    fx.add(Fx.Send(Outbound.Emit(name, payload)))
    return Outcome(true)
  }

  // ---- 受け取り・音量 ----

  private fun callEvent(s: String, peerId: String, from: String, name: String, payload: JsonNode) {
    if (!isCurrent(s) || phase != CallPhase.JOINED) return
    fx.add(Fx.Relay(peerId, from, name, payload, nextSeq()))
  }

  private fun audio(s: String, peerId: String, pcm: ByteArray) {
    if (!isCurrent(s) || phase != CallPhase.JOINED || !listed) return count("audio.drop.notjoined")
    count("audio.in")
    val m = members.firstOrNull { it.peer == peerId } ?: return count("audio.drop.unknown")
    if (m.status.muted || localMuted.contains(peerId) || deafened) return count("audio.drop.muted")
    fx.add(Fx.PlayFrame(peerId, pcm))
  }

  private fun level(s: String, peerId: String?, rms: Double, nowMs: Long) {
    if (!isCurrent(s) || phase != CallPhase.JOINED) return
    val key = peerId ?: ""
    val silent = if (peerId == null) muted else {
      val m = members.firstOrNull { it.peer == peerId }
      (m?.status?.muted ?: false) || localMuted.contains(peerId)
    }
    val st = speakState.getOrPut(key) { SpeakState() }
    val loud = !silent && rms > SPEAK_THRESHOLD
    if (loud) st.lastLoud = nowMs
    val now = !silent && nowMs - st.lastLoud < SPEAK_HOLD_MS
    if (now != st.speaking) {
      st.speaking = now
      speaking[key] = now
      changed = true
    }
  }

  // ---- 停止・失敗 ----

  private fun isCurrent(s: String): Boolean = session != null && s == session

  private fun stopIf(s: String?, reason: String): Outcome {
    if (phase == CallPhase.IDLE) return Outcome(true)
    if (s != null && s != session) return Outcome(false, "stale")
    stop(null, reason)
    return Outcome(true)
  }

  private fun fail(code: String) {
    error = NativeCallError(code, NativeCallMessages.japanese(code))
    fx.add(Fx.Report(code))
    stop(null, code)
  }

  /** 停止（wanted を先に消す）。後始末のあと IDLE に戻る */
  private fun stop(s: String?, reason: String) {
    if (phase == CallPhase.IDLE) return
    if (s != null && s != session) return
    phase = CallPhase.STOPPING
    changed = true
    // 保存の番号を無効にし、送る・録る意図を即座に止める（遅れた保存や音声が、後から効かないように）
    pendingWanted = 0L
    stopAudioFx()
    wanted = false
    // 保存が終わってから後始末する（停止の保存が完了した状態で、後始末に進む）
    fx.add(Fx.PersistWanted(false, null, status()))
    // 一覧に載っていたときだけ抜ける（載る前に止めたときは、送るものが無い）
    if (listed) fx.add(Fx.Send(Outbound.Leave))
    fx.add(Fx.SyncPeers(emptySet()))
    fx.add(Fx.CloseSocket(reason))
    fx.add(Fx.ReleaseRoute)
    fx.add(Fx.StopService(reason))
    tokens.clear()
    session = null
    config = null
    peer = null
    members = emptyList()
    listed = false
    linkUp = false
    audioRunning = false
    speakState.clear()
    speaking.clear()
    localMuted.clear()
    muteByDeafen = false
    deafened = false
    muted = false
    newGeneration(generation + 1)
    fx.add(Fx.PersistGeneration(generation))
    phase = CallPhase.IDLE
  }

  private fun stopAudioFx() {
    if (audioRunning) fx.add(Fx.StopAudio)
    audioRunning = false
  }

  private fun status(): NativeCallStatus = NativeCallStatus(muted = muted, deafened = deafened, device = device)

  private fun arm(key: TimerKey, delayMs: Long) {
    val token = (tokens[key] ?: 0L) + 1L
    tokens[key] = token
    fx.add(Fx.Timer(key, delayMs, token))
  }

  private fun cancel(key: TimerKey) {
    tokens.remove(key)
  }

  private fun count(key: String) {
    counters[key] = (counters[key] ?: 0L) + 1L
  }

}

/** 画面に出す文言（日本語）。コードは試験と記録で使い、文言だけを画面に出す */
object NativeCallMessages {
  fun japanese(code: String): String = when {
    code == "identity_mismatch" -> "このデバイスのアカウントと通話のアカウントが一致しません"
    code == "join_timeout" -> "サーバーから参加の返事がありませんでした"
    code == "connect_timeout" -> "サーバーにつながりませんでした"
    code == "auth_rejected" -> "認証されず、通話に入れませんでした"
    code == "bad_server_url" -> "サーバーの URL が正しくありません"
    code == "bad_dev_user" -> "開発用のユーザー指定が正しくありません"
    code == "service_failed" -> "通話の常駐を始められませんでした"
    code == "persist_failed" -> "通話の状態を保存できませんでした"
    code == "server_removed" -> "サーバーの通話から外れました"
    code == "kicked" -> "通話から外されました"
    code == "permission_lost" -> "マイクの許可がなくなったため、通話を止めました"
    code == "stop_unconfirmed" -> "通話の停止を保存に記録できませんでした。次の起動で確認が必要です"
    code == "peer_in_use" -> "この通話の接続 ID が別の接続に使われています"
    code.startsWith("audio_") || code.startsWith("record_") -> "マイクを開けませんでした"
    code.startsWith("track_") -> "音を再生できませんでした"
    code == "http_rejected" || code == "connect_failed" || code == "remote_closed" || code == "protocol" || code == "overflow" -> "サーバーとの接続に問題が起きました"
    code == "audio_unavailable" -> "このデバイスでは通話の音を使えません"
    else -> "通話で問題が起きました（$code）"
  }
}
