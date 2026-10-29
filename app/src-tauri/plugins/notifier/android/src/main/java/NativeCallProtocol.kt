package dev.disnans.notifier

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.JsonNodeFactory
import com.fasterxml.jackson.databind.node.ObjectNode
import okio.ByteString
import okio.ByteString.Companion.decodeBase64
import okio.ByteString.Companion.toByteString

// Pure wire protocol for native calls (contract v1). No Android/Tauri imports.
// Errors carry a fixed code only; messages never include payloads, URLs, or identities.

/** A protocol problem. [code] is a fixed, safe identifier. */
class NativeCallProtocolException(val code: String) : Exception(code)

/** Decoded server → client frame. Only the frames the native engine acts on are typed; the rest are [Other]. */
sealed interface ServerFrame {
  data class Hello(val meId: String, val meLoginName: String?) : ServerFrame
  data class CallState(val members: List<NativeCallMember>) : ServerFrame

  /** Non-audio `call.event`. [payload] is opaque and must not be logged. */
  data class Relay(val peer: String, val from: String, val name: String, val payload: JsonNode) : ServerFrame

  /** `call.event` with name `audio`, already decoded. */
  class Audio(val peer: String, val from: String, val seq: Long, val pcm: ByteArray) : ServerFrame

  /** An audio `call.event` that failed validation. Dropped; the connection stays up. */
  data class DroppedAudio(val reason: String) : ServerFrame

  data class Kicked(val by: String) : ServerFrame
  data class Error(val code: String) : ServerFrame
  object Pong : ServerFrame
  object Other : ServerFrame
}

object NativeCallProtocol {
  private val mapper = ObjectMapper()
  private val nodes = JsonNodeFactory.instance

  /** Event name used for the audio path (see pure.ts EV_AUDIO). */
  const val AUDIO_EVENT = "audio"

  private val PEER = Regex("^[A-Za-z0-9_-]{1,${NativeCallLimits.MAX_PEER_CHARS}}$")
  private val SESSION = Regex("^[A-Za-z0-9-]{1,${NativeCallLimits.MAX_SESSION_CHARS}}$")
  private val PADDED_BASE64 = Regex("^[A-Za-z0-9+/]*={0,2}$")

  // ---- outgoing frames (client → server) ----

  fun join(peer: String, status: NativeCallStatus): String {
    requirePeer(peer)
    return frame("call.join") {
      put("peer", peer)
      set<ObjectNode>("status", statusNode(status))
    }
  }

  fun leave(): String = frame("call.leave") {}

  fun alive(): String = frame("call.alive") {}

  fun update(status: NativeCallStatus): String =
    frame("call.update") { set<ObjectNode>("status", statusNode(status)) }

  fun kick(peer: String): String {
    requirePeer(peer)
    return frame("call.kick") { put("peer", peer) }
  }

  /**
   * Generic `call.emit` (plugins, screenshare). The payload is opaque and must be ≤ 64 KB serialized.
   * Throws [NativeCallProtocolException] for an invalid name or an oversized payload.
   */
  fun emit(name: String, payload: JsonNode): String {
    requireEventName(name)
    if (name == AUDIO_EVENT) throw NativeCallProtocolException("reserved_event")
    requirePayloadSize(payload)
    return frame("call.emit") {
      put("name", name)
      set<JsonNode>("payload", payload)
    }
  }

  /**
   * Audio `call.emit`: payload `{seq, pcm}` where pcm is standard padded base64 of PCM16 LE mono.
   * Accepts 2…[NativeCallLimits.PCM_FRAME_BYTES]*4 even byte counts (the receiver's cap).
   */
  fun audio(seq: Long, pcm: ByteArray): String {
    if (pcm.isEmpty() || pcm.size % 2 != 0 || pcm.size > 6144) throw NativeCallProtocolException("bad_pcm_size")
    val payload = nodes.objectNode().apply {
      put("seq", seq)
      put("pcm", pcm.toByteString().base64())
    }
    return frame("call.emit") {
      put("name", AUDIO_EVENT)
      set<JsonNode>("payload", payload)
    }
  }

  /** Standard padded base64 of PCM16 bytes (used by tests and the audio path). */
  fun encodePcm(pcm: ByteArray): String = pcm.toByteString().base64()

  /** UTF-8 byte length of [text], counted without allocating (queue caps use bytes, not chars). */
  fun utf8Length(text: String): Long {
    var n = 0L
    var i = 0
    while (i < text.length) {
      val c = text[i]
      if (c.code < 0x80) {
        n += 1
      } else if (c.code < 0x800) {
        n += 2
      } else if (Character.isHighSurrogate(c) && i + 1 < text.length && Character.isLowSurrogate(text[i + 1])) {
        n += 4
        i++
      } else {
        n += 3
      }
      i++
    }
    return n
  }

  // ---- incoming frames (server → client) ----

  /**
   * Decodes one text frame. Malformed JSON, a non-object frame, or a malformed known frame throws
   * [NativeCallProtocolException] (the transport closes). Unknown `type` values are [ServerFrame.Other].
   * A malformed audio `call.event` is [ServerFrame.DroppedAudio] (not a protocol error).
   */
  fun decode(text: String): ServerFrame {
    if (text.length > NativeCallLimits.MAX_INCOMING_FRAME_CHARS) throw NativeCallProtocolException("frame_too_large")
    val root = try {
      mapper.readTree(text)
    } catch (_: Exception) {
      throw NativeCallProtocolException("bad_json")
    }
    if (root == null || !root.isObject) throw NativeCallProtocolException("bad_frame")
    return when (root.str("type")) {
      "hello" -> {
        val me = root.obj("me")
        ServerFrame.Hello(meId = me.str("id"), meLoginName = me.optStr("login_name"))
      }
      "call.state" -> ServerFrame.CallState(root.arr("members").map { member(it) })
      "call.event" -> event(root)
      "call.kicked" -> ServerFrame.Kicked(root.str("by"))
      "error" -> ServerFrame.Error(knownRemoteCode(root.get("code")))
      "pong" -> ServerFrame.Pong
      else -> ServerFrame.Other
    }
  }

  /**
   * Remote error codes that may pass into typed frames (and later into diagnostics). Anything else becomes
   * [SERVER_ERROR], so untrusted text (URLs, tokens, payloads) can never reach logs through a code.
   * Lists the codes the server actually sends for WebSocket/call requests, plus the chat codes the client-core
   * rejects on the same socket.
   */
  private val KNOWN_REMOTE_CODES = setOf(
    "peer_in_use", "not_in_call", "ws_only", "invalid_peer", "invalid_event", "invalid_event_name",
    "invalid_kick", "invalid_status", "payload_too_large", "peer_not_found", "invalid_body", "invalid_emoji",
    "invalid_icon", "invalid_manifest", "invalid_message_id", "empty_message", "body_too_long",
    "reply_not_found", "reply_other_place", "invalid_attachment", "invalid_link", "server_error",
  )

  const val SERVER_ERROR = "server_error"

  /** Non-text or unknown codes become [SERVER_ERROR]; known codes pass through unchanged. */
  private fun knownRemoteCode(node: JsonNode?): String {
    val code = if (node != null && node.isTextual) node.asText() else return SERVER_ERROR
    return if (code in KNOWN_REMOTE_CODES) code else SERVER_ERROR
  }

  private fun event(root: JsonNode): ServerFrame {
    val peer = root.str("peer")
    val from = root.str("from")
    val name = root.str("name")
    val payload = root.get("payload") ?: throw NativeCallProtocolException("bad_frame")
    if (name != AUDIO_EVENT) return ServerFrame.Relay(peer, from, name, payload)
    // Audio: validate here so the engine receives only usable PCM.
    val seq = payload.get("seq")
    if (seq == null || !seq.isIntegralNumber) return ServerFrame.DroppedAudio("bad_seq")
    val pcm = decodePcm(payload.get("pcm")?.takeIf { it.isTextual }?.asText())
      ?: return ServerFrame.DroppedAudio("bad_pcm")
    return ServerFrame.Audio(peer, from, seq.asLong(), pcm)
  }

  /**
   * Decodes inbound audio base64 the way `atob` does (pure.ts base64ToPcm):
   * ASCII whitespace is ignored; trailing `=` is optional (stripped when the length is a multiple of 4);
   * length mod 4 == 1, any character outside the standard alphabet, and URL-safe characters are refused.
   * Raw input is capped at [NativeCallLimits.MAX_INBOUND_PCM_BASE64_CHARS]. Decoded length must be even and non-zero.
   * Returns null when any rule fails. This is the single validator; NativePcm must delegate here.
   */
  fun decodePcm(b64: String?): ByteArray? {
    if (b64 == null || b64.length > NativeCallLimits.MAX_INBOUND_PCM_BASE64_CHARS) return null
    val sb = StringBuilder(b64.length)
    for (c in b64) {
      if (c == ' ' || c == '\t' || c == '\n' || c == '\u000c' || c == '\r') continue
      sb.append(c)
    }
    var s = sb.toString()
    if (s.length % 4 == 0) {
      if (s.endsWith("==")) {
        s = s.substring(0, s.length - 2)
      } else if (s.endsWith("=")) {
        s = s.substring(0, s.length - 1)
      }
    }
    if (s.isEmpty() || s.length % 4 == 1) return null
    for (c in s) {
      val ok = (c in 'A'..'Z') || (c in 'a'..'z') || (c in '0'..'9') || c == '+' || c == '/'
      if (!ok) return null
    }
    val bytes: ByteString = s.decodeBase64() ?: return null
    if (bytes.size == 0 || bytes.size % 2 != 0) return null
    return bytes.toByteArray()
  }

  /** Top-level `{session}` (stop, control, emit, kick style). Same validator as the start arguments. */
  fun parseSession(raw: String): String {
    val session = parseObject(raw).str("session")
    if (!SESSION.matches(session)) throw NativeCallProtocolException("bad_session")
    return session
  }

  /** `native_call_emit`: `{session, name, payload}`. Audio is reserved for the native path. */
  fun parseEmitArgs(raw: String): NativeCallEmitArgs {
    val o = parseObject(raw)
    val session = o.str("session")
    if (!SESSION.matches(session)) throw NativeCallProtocolException("bad_session")
    val name = o.str("name")
    requireEventName(name)
    if (name == AUDIO_EVENT) throw NativeCallProtocolException("reserved_event")
    val payload = o.get("payload") ?: throw NativeCallProtocolException("bad_payload")
    requirePayloadSize(payload)
    return NativeCallEmitArgs(session, name, payload)
  }

  // ---- start / stop / control arguments (from JS, as JSON text) ----

  fun parseStartArgs(json: String): NativeCallStartArgs {
    val o = parseObject(json)
    val session = o.str("session")
    if (!SESSION.matches(session)) throw NativeCallProtocolException("bad_session")
    val serverUrl = o.str("serverUrl")
    if (serverUrl.isEmpty() || serverUrl.length > 512) throw NativeCallProtocolException("bad_server_url")
    val expectedUserId = o.str("expectedUserId")
    if (expectedUserId.isEmpty() || expectedUserId.length > 256 || expectedUserId.any { it.isISOControl() }) {
      throw NativeCallProtocolException("bad_user_id")
    }
    val devUser = o.optStr("devUser")
    if (devUser != null && (devUser.isBlank() || devUser.length > 256 || !devUser.all { it.code in 0x20..0x7e })) {
      throw NativeCallProtocolException("bad_dev_user")
    }
    val status = parseStatus(o.obj("status"))
    val settings = parseSettings(o.obj("settings"))
    val localMuted = o.optArr("localMuted")?.map { peerOf(it) } ?: emptyList()
    if (localMuted.size > 256) throw NativeCallProtocolException("too_many_local_muted")
    return NativeCallStartArgs(session, serverUrl, expectedUserId, devUser, status, settings, localMuted)
  }

  fun parseStopArgs(json: String): NativeCallStopArgs {
    val o = parseObject(json)
    val session = o.str("session")
    if (!SESSION.matches(session)) throw NativeCallProtocolException("bad_session")
    val reason = o.str("reason")
    if (reason.length > 64) throw NativeCallProtocolException("bad_reason")
    return NativeCallStopArgs(session, reason)
  }

  /** `native_call_control`: `{session, patch}`. */
  fun parseControlArgs(raw: String): NativeCallControlArgs {
    val session = parseSession(raw)
    return NativeCallControlArgs(session, parseControlPatch(raw))
  }

  /** Partial control patch. Unknown keys are ignored; present keys are validated. */
  fun parseControlPatch(json: String): NativeCallControlPatch {
    val o = parseObject(json)
    val p = o.get("patch")?.takeIf { it.isObject } ?: throw NativeCallProtocolException("bad_patch")
    return NativeCallControlPatch(
      muted = p.optBool("muted"),
      deafened = p.optBool("deafened"),
      peerMute = p.optObj("peerMute")?.let { NativeCallPeerMute(peerOf(it.str("peer")), it.bool("muted")) },
      settings = p.optObj("settings")?.let { parseSettingsPatch(it) },
    )
  }

  fun parseKickArgs(json: String): Pair<String, String> {
    val o = parseObject(json)
    if (!SESSION.matches(o.str("session"))) throw NativeCallProtocolException("bad_session")
    return o.str("session") to peerOf(o.str("peer"))
  }

  // ---- events to JS (`call_native`) ----

  /** Serialized event for `call_native` (JSON text). */
  fun eventJson(event: NativeCallEvent): String = encodeEvent(event)

  /** Serialized snapshot (READ ONLY surface). Members use `user_id`. */
  fun snapshotJson(snapshot: NativeCallSnapshot): String = encodeSnapshot(snapshot)

  fun encodeEvent(event: NativeCallEvent): String = when (event) {
    is NativeCallEvent.State -> nodes.objectNode().apply {
      put("kind", "state")
      set<ObjectNode>("snapshot", snapshotNode(event.snapshot))
    }
    is NativeCallEvent.Relay -> nodes.objectNode().apply {
      val r = event.relay
      put("kind", "relay")
      put("session", r.session)
      put("generation", r.generation)
      put("seq", r.seq)
      put("peer", r.peer)
      put("from", r.from)
      put("name", r.name)
      set<JsonNode>("payload", r.payload)
    }
  }.let { mapper.writeValueAsString(it) }

  /** Snapshot as JSON text (READ ONLY surface). Members use `user_id` (wire CallMember). */
  fun encodeSnapshot(s: NativeCallSnapshot): String = mapper.writeValueAsString(snapshotNode(s))

  /** The wss/ws URL for `/api/ws`, same rule as the notifier's socket. Throws for non-http(s) input. */
  fun wsUrl(serverUrl: String): String {
    val lower = serverUrl.lowercase()
    if (!(lower.startsWith("http://") || lower.startsWith("https://"))) throw NativeCallProtocolException("bad_server_url")
    return serverUrl.replaceFirst(Regex("^http", RegexOption.IGNORE_CASE), "ws").trimEnd('/') + "/api/ws"
  }

  // ---- internals ----

  private inline fun frame(type: String, body: ObjectNode.() -> Unit): String {
    val o = nodes.objectNode()
    o.put("type", type)
    o.body()
    return mapper.writeValueAsString(o)
  }

  private fun statusNode(s: NativeCallStatus): ObjectNode = nodes.objectNode().apply {
    put("muted", s.muted)
    put("deafened", s.deafened)
    val device = s.device?.takeIf { it.isNotEmpty() }
    if (device != null && device.length > NativeCallLimits.MAX_DEVICE_CHARS) throw NativeCallProtocolException("bad_device")
    if (device == null) putNull("device") else put("device", device)
  }

  private fun snapshotNode(s: NativeCallSnapshot): ObjectNode = nodes.objectNode().apply {
    if (s.session == null) putNull("session") else put("session", s.session)
    put("generation", s.generation)
    put("seq", s.seq)
    put("wanted", s.wanted)
    put("phase", s.phase.wire)
    if (s.serverUrl == null) putNull("serverUrl") else put("serverUrl", s.serverUrl)
    if (s.peer == null) putNull("peer") else put("peer", s.peer)
    putArray("members").also { arr -> s.members.forEach { arr.add(memberNode(it)) } }
    put("muted", s.muted)
    put("deafened", s.deafened)
    put("muteByDeafen", s.muteByDeafen)
    putObject("speaking").also { o -> s.speaking.forEach { (k, v) -> o.put(k, v) } }
    putArray("localMuted").also { arr -> s.localMuted.forEach { arr.add(it) } }
    set<ObjectNode>("settings", settingsNode(s.settings))
    put("linkUp", s.linkUp)
    put("listed", s.listed)
    put("bufferedBytes", s.bufferedBytes)
    val e = s.error
    if (e == null) {
      putNull("error")
    } else {
      set<ObjectNode>("error", nodes.objectNode().apply {
        put("code", e.code)
        put("message", e.message)
        if (e.by != null) put("by", e.by)
      })
    }
  }

  private fun memberNode(m: NativeCallMember): ObjectNode = nodes.objectNode().apply {
    put("peer", m.peer)
    put("user_id", m.userId)
    set<ObjectNode>("status", statusNode(m.status))
  }

  private fun settingsNode(s: NativeCallSettings): ObjectNode = nodes.objectNode().apply {
    put("micVolume", s.micVolume)
    put("outVolume", s.outVolume)
    put("limiter", s.limiter)
    put("limitDb", s.limitDb)
    put("rawInput", s.rawInput)
    if (s.outputId == null) putNull("outputId") else put("outputId", s.outputId)
  }

  private fun member(n: JsonNode): NativeCallMember {
    if (!n.isObject) throw NativeCallProtocolException("bad_member")
    return NativeCallMember(peer = peerOf(n.str("peer")), userId = n.str("user_id"), status = parseStatus(n.obj("status")))
  }

  private fun parseStatus(o: JsonNode): NativeCallStatus {
    val device = o.optStr("device")?.takeIf { it.isNotEmpty() }
    if (device != null && device.length > NativeCallLimits.MAX_DEVICE_CHARS) throw NativeCallProtocolException("bad_device")
    return NativeCallStatus(muted = o.bool("muted"), deafened = o.bool("deafened"), device = device)
  }

  private fun parseSettings(o: JsonNode): NativeCallSettings {
    val outputId = o.optStr("outputId")
    if (outputId != null && (outputId.isEmpty() || outputId.length > 256)) throw NativeCallProtocolException("bad_output")
    return NativeCallSettings(
      micVolume = micVolume(o.num("micVolume")),
      outVolume = outVolume(o.num("outVolume")),
      limiter = o.bool("limiter"),
      limitDb = limitDb(o.num("limitDb")),
      rawInput = o.bool("rawInput"),
      outputId = outputId,
    )
  }

  private fun parseSettingsPatch(o: JsonNode): NativeCallSettingsPatch {
    val outputPresent = o.has("outputId")
    val outputValue = o.get("outputId")
    val output: OutputIdPatch? = if (!outputPresent) {
      null
    } else if (outputValue.isNull) {
      OutputIdPatch(null)
    } else {
      val s = outputValue.takeIf { it.isTextual }?.asText()
      if (s == null || s.isEmpty() || s.length > 256) throw NativeCallProtocolException("bad_output")
      OutputIdPatch(s)
    }
    return NativeCallSettingsPatch(
      micVolume = o.optNum("micVolume")?.let { micVolume(it) },
      outVolume = o.optNum("outVolume")?.let { outVolume(it) },
      limiter = o.optBool("limiter"),
      limitDb = o.optNum("limitDb")?.let { limitDb(it) },
      rawInput = o.optBool("rawInput"),
      outputId = output,
    )
  }

  private fun micVolume(v: Double): Double = ranged(v, NativeCallLimits.MIC_VOLUME_MAX)

  private fun outVolume(v: Double): Double = ranged(v, NativeCallLimits.OUT_VOLUME_MAX)

  /** Finite and within [0, max]. Out-of-range values are refused, not clamped. */
  private fun ranged(v: Double, max: Double): Double {
    if (!v.isFinite() || v < 0.0 || v > max) throw NativeCallProtocolException("bad_volume")
    return v
  }

  /** Finite and within the authoritative dB range. Refused, not clamped. */
  private fun limitDb(v: Double): Double {
    if (!v.isFinite() || v < NativeCallLimits.LIMIT_DB_MIN || v > NativeCallLimits.LIMIT_DB_MAX) {
      throw NativeCallProtocolException("bad_limit")
    }
    return v
  }

  private fun peerOf(s: String): String {
    if (!PEER.matches(s)) throw NativeCallProtocolException("invalid_peer")
    return s
  }

  private fun peerOf(n: JsonNode): String = peerOf(if (n.isTextual) n.asText() else throw NativeCallProtocolException("invalid_peer"))

  private fun requirePeer(peer: String) {
    peerOf(peer)
  }

  private fun requireEventName(name: String) {
    if (name.isEmpty() || name.length > NativeCallLimits.MAX_EVENT_NAME_CHARS) throw NativeCallProtocolException("invalid_event_name")
  }

  private fun requirePayloadSize(payload: JsonNode) {
    if (mapper.writeValueAsBytes(payload).size > NativeCallLimits.MAX_PAYLOAD_BYTES) {
      throw NativeCallProtocolException("payload_too_large")
    }
  }

  private fun parseObject(json: String): JsonNode {
    val root = try {
      mapper.readTree(json)
    } catch (_: Exception) {
      throw NativeCallProtocolException("bad_json")
    }
    if (root == null || !root.isObject) throw NativeCallProtocolException("bad_json")
    return root
  }

  private fun JsonNode.str(key: String): String =
    get(key)?.takeIf { it.isTextual }?.asText() ?: throw NativeCallProtocolException("bad_$key")

  private fun JsonNode.optStr(key: String): String? {
    val v = get(key) ?: return null
    if (v.isNull) return null
    if (!v.isTextual) throw NativeCallProtocolException("bad_$key")
    return v.asText()
  }

  private fun JsonNode.bool(key: String): Boolean =
    get(key)?.takeIf { it.isBoolean }?.asBoolean() ?: throw NativeCallProtocolException("bad_$key")

  private fun JsonNode.optBool(key: String): Boolean? {
    val v = get(key) ?: return null
    if (!v.isBoolean) throw NativeCallProtocolException("bad_$key")
    return v.asBoolean()
  }

  private fun JsonNode.num(key: String): Double =
    get(key)?.takeIf { it.isNumber }?.asDouble() ?: throw NativeCallProtocolException("bad_$key")

  private fun JsonNode.optNum(key: String): Double? {
    val v = get(key) ?: return null
    if (!v.isNumber) throw NativeCallProtocolException("bad_$key")
    return v.asDouble()
  }

  private fun JsonNode.obj(key: String): JsonNode =
    get(key)?.takeIf { it.isObject } ?: throw NativeCallProtocolException("bad_$key")

  private fun JsonNode.optObj(key: String): JsonNode? {
    val v = get(key) ?: return null
    if (!v.isObject) throw NativeCallProtocolException("bad_$key")
    return v
  }

  private fun JsonNode.arr(key: String): List<JsonNode> =
    get(key)?.takeIf { it.isArray }?.toList() ?: throw NativeCallProtocolException("bad_$key")

  private fun JsonNode.optArr(key: String): List<JsonNode>? {
    val v = get(key) ?: return null
    if (!v.isArray) throw NativeCallProtocolException("bad_$key")
    return v.toList()
  }
}
