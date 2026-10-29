package dev.disnans.notifier

import com.fasterxml.jackson.databind.JsonNode

// Native call DTOs (see docs/design/android-call.md and app/src/lib/call/native.ts).
// Pure Kotlin + Jackson JsonNode only. No Android/Tauri imports, so JVM tests can run.
// Wire names are mapped in NativeCallProtocol.kt; these Kotlin names are camelCase.

/** The call status a connection announces itself (wire: CallStatus). */
data class NativeCallStatus(
  val muted: Boolean,
  val deafened: Boolean,
  /** smartphone / tablet / laptop / monitor, or null */
  val device: String?,
)

/** One connection in the call (wire: CallMember, `user_id` on the wire). */
data class NativeCallMember(
  val peer: String,
  val userId: String,
  val status: NativeCallStatus,
)

/** Playback and capture settings (native is the source of truth while a session runs). */
data class NativeCallSettings(
  val micVolume: Double,
  val outVolume: Double,
  val limiter: Boolean,
  val limitDb: Double,
  val rawInput: Boolean,
  /** Saved output id; re-applied only when it is available. */
  val outputId: String?,
)

/** Arguments of `native_call_start`. */
data class NativeCallStartArgs(
  /** JS-generated logical session token (ASCII, <= 48 chars). */
  val session: String,
  val serverUrl: String,
  /** Must equal hello.me.id before call.join. */
  val expectedUserId: String,
  /** Dev identity (X-Dev-User). Stored privately only while a call is wanted; never logged. */
  val devUser: String?,
  val status: NativeCallStatus,
  val settings: NativeCallSettings,
  val localMuted: List<String> = emptyList(),
)

/** Partial patch for `native_call_control`. A null field means "unchanged". */
data class NativeCallPeerMute(val peer: String, val muted: Boolean)

data class NativeCallSettingsPatch(
  val micVolume: Double? = null,
  val outVolume: Double? = null,
  val limiter: Boolean? = null,
  val limitDb: Double? = null,
  val rawInput: Boolean? = null,
  /** Null = unchanged. `OutputIdPatch(null)` clears the saved output. */
  val outputId: OutputIdPatch? = null,
)

/** Explicit wrapper so "set to null" (clear) is distinct from "unchanged". */
data class OutputIdPatch(val value: String?)

data class NativeCallControlPatch(
  val muted: Boolean? = null,
  val deafened: Boolean? = null,
  val peerMute: NativeCallPeerMute? = null,
  val settings: NativeCallSettingsPatch? = null,
)

/** Arguments of `native_call_stop`. */
data class NativeCallStopArgs(val session: String, val reason: String)

/** Arguments of `native_call_control`: the logical session plus a partial patch. */
data class NativeCallControlArgs(val session: String, val patch: NativeCallControlPatch)

/** Arguments of `native_call_emit`: opaque generic event (audio is never accepted here). */
data class NativeCallEmitArgs(val session: String, val name: String, val payload: JsonNode)

/** Lifecycle phase reported in the snapshot (wire: lowercase). */
enum class NativeCallPhase(val wire: String) {
  IDLE("idle"),
  JOINING("joining"),
  JOINED("joined"),
  RECOVERING("recovering"),
  STOPPING("stopping"),
}

/** Last error, reported once (not on every reconnect or meter tick). */
data class NativeCallError(
  val code: String,
  val message: String,
  /** Only set for kicks: the login-side user id that removed us, if known. */
  val by: String? = null,
)

/**
 * Snapshot (READ ONLY). Wire JSON: see NativeCallProtocol.encodeSnapshot.
 * `generation` is the persisted owner epoch; `seq` increases in memory for every emitted event.
 */
data class NativeCallSnapshot(
  val session: String?,
  val generation: Long,
  val seq: Long,
  val wanted: Boolean,
  val phase: NativeCallPhase,
  val serverUrl: String?,
  val peer: String?,
  val members: List<NativeCallMember>,
  val muted: Boolean,
  val deafened: Boolean,
  val muteByDeafen: Boolean,
  /** 自分の発言は空文字のキー、相手の発言は peer をキーにする。 */
  val speaking: Map<String, Boolean>,
  val localMuted: List<String>,
  val settings: NativeCallSettings,
  val linkUp: Boolean,
  val listed: Boolean,
  val bufferedBytes: Long,
  val error: NativeCallError?,
)

/** Non-audio call event relayed to JS (`call_native` kind `relay`). Audio is never relayed. */
data class NativeCallRelay(
  val session: String,
  val generation: Long,
  val seq: Long,
  val peer: String,
  val from: String,
  val name: String,
  /** Opaque JSON payload, passed through unchanged. Never logged. */
  val payload: JsonNode,
)

/** Events published on the notifier channel `call_native`. */
sealed interface NativeCallEvent {
  data class State(val snapshot: NativeCallSnapshot) : NativeCallEvent
  data class Relay(val relay: NativeCallRelay) : NativeCallEvent
}

/** Limits shared by the protocol and the transport (see contract "Audio / protocol parity"). */
object NativeCallLimits {
  /** Authoritative ranges: crates/client-core/src/view/settings.rs (MIC_VOLUME_MAX, OUT_VOLUME_MAX, LIMIT_DB_*). Minimum volume is 0. */
  const val MIC_VOLUME_MAX: Double = 2.0
  const val OUT_VOLUME_MAX: Double = 1.0
  const val LIMIT_DB_MIN: Double = -18.0
  const val LIMIT_DB_MAX: Double = -3.0

  /** Relayed call.emit payload cap (bytes of serialized JSON). */
  const val MAX_PAYLOAD_BYTES: Int = 64 * 1024
  const val MAX_EVENT_NAME_CHARS: Int = 64
  const val MAX_PEER_CHARS: Int = 64
  const val MAX_DEVICE_CHARS: Int = 32
  const val MAX_SESSION_CHARS: Int = 48

  /** Standard padded base64 of one 800-sample PCM16 frame (1600 bytes) is 2136 chars. */
  const val PCM_FRAME_BYTES: Int = 1600
  const val PCM_BASE64_CHARS: Int = 2136

  /** Inbound base64 max, as the existing pure.ts receiver. */
  const val MAX_INBOUND_PCM_BASE64_CHARS: Int = 8192

  /** Largest incoming text frame accepted (server message limit is 8 MiB). */
  const val MAX_INCOMING_FRAME_CHARS: Int = 8 * 1024 * 1024
}
