package dev.disnans.notifier

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import okio.ByteString.Companion.toByteString

// Pure protocol tests (no JUnit). Run with NativeCallProtocolTests.run(), which returns the number of
// named cases and throws AssertionError("<case>: <detail>") on the first failure.
//
// Golden sources (hand-written from the server serde, not generated):
//   crates/shared/src/lib.rs  ClientEvent / ServerEvent (#[serde(tag = "type")], rename per variant)
//   crates/shared/src/lib.rs  CallStatus {muted, deafened, device}; CallMember {peer, user_id, status}
//   crates/server/src/calls.rs  payload cap 64 KB, event name 64, peer 64, device 32
//   app/src/lib/call/pure.ts  base64ToPcm (atob) and EV_AUDIO; PCM vectors in test resources come from atob
//   crates/client-core/src/view/settings.rs  MIC_VOLUME_MAX 2.0, OUT_VOLUME_MAX 1.0, LIMIT_DB -18..-3
object NativeCallProtocolTests {
  private val mapper = ObjectMapper()
  private val status = NativeCallStatus(muted = false, deafened = false, device = "smartphone")
  private var count = 0

  private fun case(name: String, block: () -> Unit) {
    try {
      block()
    } catch (e: AssertionError) {
      throw AssertionError("$name: ${e.message}")
    } catch (e: Exception) {
      throw AssertionError("$name: threw ${e.javaClass.simpleName}")
    }
    count++
  }

  private fun eq(expected: Any?, actual: Any?) {
    if (expected != actual) throw AssertionError("expected <$expected> but was <$actual>")
  }

  private fun yes(cond: Boolean, what: String) {
    if (!cond) throw AssertionError(what)
  }

  private fun codeOf(block: () -> Unit): String {
    try {
      block()
    } catch (e: NativeCallProtocolException) {
      return e.code
    }
    throw AssertionError("expected NativeCallProtocolException")
  }

  private fun startJson(outVolume: String = "0.5", micVolume: String = "1", limitDb: String = "-6", session: String = "abc-123", devUser: String = "null") = """
    {"session":"$session","serverUrl":"http://100.1.2.3:8080","expectedUserId":"u1","devUser":$devUser,
     "status":{"muted":false,"deafened":false,"device":"smartphone"},
     "settings":{"micVolume":$micVolume,"outVolume":$outVolume,"limiter":true,"limitDb":$limitDb,"rawInput":false,"outputId":null},
     "localMuted":["p2"]}
  """.trimIndent()

  private val snapshot = NativeCallSnapshot(
    session = "abc-123", generation = 3, seq = 42, wanted = true, phase = NativeCallPhase.JOINED,
    serverUrl = null, peer = "p1",
    members = listOf(NativeCallMember("p1", "u1", status)),
    muted = false, deafened = false, muteByDeafen = false,
    speaking = mapOf("p1" to true), localMuted = emptyList(),
    settings = NativeCallSettings(1.0, 1.0, false, -6.0, false, null),
    linkUp = true, listed = true, bufferedBytes = 0, error = null,
  )

  fun run(): Int {
    count = 0
    outgoingGoldens()
    audioBase64()
    pcmVectors()
    incomingFrames()
    startControlArgs()
    eventsAndUrl()
    return count
  }

  private fun outgoingGoldens() {
    case("join golden") {
      eq("""{"type":"call.join","peer":"abc-1","status":{"muted":false,"deafened":false,"device":"smartphone"}}""", NativeCallProtocol.join("abc-1", status))
    }
    case("null device serializes as null, not empty") {
      eq(
        """{"type":"call.update","status":{"muted":true,"deafened":false,"device":null}}""",
        NativeCallProtocol.update(NativeCallStatus(muted = true, deafened = false, device = "")),
      )
    }
    case("leave, alive, kick golden") {
      eq("""{"type":"call.leave"}""", NativeCallProtocol.leave())
      eq("""{"type":"call.alive"}""", NativeCallProtocol.alive())
      eq("""{"type":"call.kick","peer":"p_1"}""", NativeCallProtocol.kick("p_1"))
    }
    case("generic emit golden") {
      eq("""{"type":"call.emit","name":"screen","payload":{"a":1}}""", NativeCallProtocol.emit("screen", mapper.readTree("""{"a":1}""")))
    }
    case("peer validation on outgoing") {
      eq("invalid_peer", codeOf { NativeCallProtocol.join("bad peer", status) })
      eq("invalid_peer", codeOf { NativeCallProtocol.kick("") })
      eq("invalid_peer", codeOf { NativeCallProtocol.join("p".repeat(65), status) })
      eq("p".repeat(64), mapper.readTree(NativeCallProtocol.kick("p".repeat(64))).get("peer").asText())
    }
    case("emit rejects reserved audio, bad names, oversize payload") {
      val p = mapper.readTree("{}")
      eq("reserved_event", codeOf { NativeCallProtocol.emit("audio", p) })
      eq("invalid_event_name", codeOf { NativeCallProtocol.emit("", p) })
      eq("invalid_event_name", codeOf { NativeCallProtocol.emit("n".repeat(65), p) })
      eq("payload_too_large", codeOf { NativeCallProtocol.emit("screen", mapper.readTree("""{"s":"${"x".repeat(64 * 1024)}"}""")) })
    }
    case("utf8 length counts bytes") {
      eq(1L, NativeCallProtocol.utf8Length("a"))
      eq(2L, NativeCallProtocol.utf8Length("é"))
      eq(3L, NativeCallProtocol.utf8Length("あ"))
      eq(4L, NativeCallProtocol.utf8Length("\uD83D\uDE00"))
      eq(200L, NativeCallProtocol.utf8Length("é".repeat(100)))
    }
  }

  private fun audioBase64() {
    case("audio frame: 1600 bytes -> 2136 padded base64, seq and pcm only") {
      val pcm = ByteArray(1600) { (it % 251).toByte() }
      val node = mapper.readTree(NativeCallProtocol.audio(7L, pcm))
      eq("call.emit", node.get("type").asText())
      eq("audio", node.get("name").asText())
      eq(7L, node.get("payload").get("seq").asLong())
      val b64 = node.get("payload").get("pcm").asText()
      eq(2136, b64.length)
      eq(setOf("seq", "pcm"), node.get("payload").fieldNames().asSequence().toSet())
      eq(pcm.toList(), NativeCallProtocol.decodePcm(b64)!!.toList())
    }
    case("audio rejects odd, empty, oversized pcm") {
      eq("bad_pcm_size", codeOf { NativeCallProtocol.audio(1L, ByteArray(3)) })
      eq("bad_pcm_size", codeOf { NativeCallProtocol.audio(1L, ByteArray(0)) })
      eq("bad_pcm_size", codeOf { NativeCallProtocol.audio(1L, ByteArray(6146)) })
    }
    case("encodePcm equals okio standard base64") {
      val pcm = ByteArray(10) { it.toByte() }
      eq(pcm.toByteString().base64(), NativeCallProtocol.encodePcm(pcm))
    }
  }

  /** Each row was produced by atob (pure.ts base64ToPcm). Kotlin must make the same accept/reject decision. */
  private fun pcmVectors() {
    case("inbound PCM matches atob vectors (resource pcm_base64_vectors.jsonl)") {
      val stream = NativeCallProtocolTests::class.java.getResourceAsStream("/pcm_base64_vectors.jsonl")
        ?: throw AssertionError("missing resource pcm_base64_vectors.jsonl")
      var rows = 0
      stream.bufferedReader(Charsets.UTF_8).useLines { lines ->
        lines.filter { it.isNotBlank() }.forEach { line ->
          val node: JsonNode = mapper.readTree(line)
          val input = node.get("in").asText()
          val expected = if (node.get("bytes").isNull) null else node.get("bytes").asInt()
          val got = NativeCallProtocol.decodePcm(input)?.size
          if (got != expected) throw AssertionError("row ${rows + 1} (len ${input.length}): expected $expected, got $got")
          rows++
        }
      }
      yes(rows >= 20, "too few vectors: $rows")
    }
    case("inbound 1600-byte frame decodes padded and unpadded and with whitespace") {
      val pcm = ByteArray(1600) { (it * 3).toByte() }
      val padded = NativeCallProtocol.encodePcm(pcm)
      eq(pcm.toList(), NativeCallProtocol.decodePcm(padded)!!.toList())
      eq(pcm.toList(), NativeCallProtocol.decodePcm(padded.trimEnd('='))!!.toList())
      eq(pcm.toList(), NativeCallProtocol.decodePcm(padded.chunked(76).joinToString("\n"))!!.toList())
    }
  }

  private fun incomingFrames() {
    case("hello and call.state") {
      val hello = NativeCallProtocol.decode(
        """{"type":"hello","me":{"id":"u1","login_name":"a@x","display_name":"A","avatar_url":null,"created_at":1},"users":[]}""",
      ) as ServerFrame.Hello
      eq("u1", hello.meId)
      val state = NativeCallProtocol.decode(
        """{"type":"call.state","members":[{"peer":"p1","user_id":"u1","status":{"muted":true,"deafened":false,"device":null}}]}""",
      ) as ServerFrame.CallState
      eq(listOf(NativeCallMember("p1", "u1", NativeCallStatus(true, false, null))), state.members)
    }
    case("audio call.event round trip") {
      val pcm = ByteArray(1600) { 5 }
      val frame = """{"type":"call.event","peer":"p1","from":"u1","name":"audio","payload":{"seq":9,"pcm":"${NativeCallProtocol.encodePcm(pcm)}"}}"""
      val audio = NativeCallProtocol.decode(frame) as ServerFrame.Audio
      eq("p1", audio.peer)
      eq("u1", audio.from)
      eq(9L, audio.seq)
      eq(pcm.toList(), audio.pcm.toList())
    }
    case("malformed audio is DroppedAudio, not a protocol error") {
      fun audioWith(payload: String) = """{"type":"call.event","peer":"p1","from":"u1","name":"audio","payload":$payload}"""
      yes(NativeCallProtocol.decode(audioWith("""{"seq":1,"pcm":"AAAA"}""")) is ServerFrame.DroppedAudio, "3 bytes")
      yes(NativeCallProtocol.decode(audioWith("""{"seq":1,"pcm":""}""")) is ServerFrame.DroppedAudio, "empty")
      yes(NativeCallProtocol.decode(audioWith("""{"seq":1,"pcm":"@@@@"}""")) is ServerFrame.DroppedAudio, "invalid chars")
      yes(NativeCallProtocol.decode(audioWith("""{"seq":1}""")) is ServerFrame.DroppedAudio, "missing pcm")
      yes(NativeCallProtocol.decode(audioWith("""{"seq":"x","pcm":"AAAA"}""")) is ServerFrame.DroppedAudio, "bad seq")
      yes(NativeCallProtocol.decode(audioWith("""{"seq":1,"pcm":5}""")) is ServerFrame.DroppedAudio, "pcm not text")
      yes(NativeCallProtocol.decode(audioWith("""{"seq":1,"pcm":"AAA="}""")) is ServerFrame.Audio, "2 bytes is valid")
    }
    case("seq is never used to drop audio (reset after restart is accepted)") {
      val pcm = NativeCallProtocol.encodePcm(ByteArray(1600))
      val a = NativeCallProtocol.decode("""{"type":"call.event","peer":"p1","from":"u1","name":"audio","payload":{"seq":1000000,"pcm":"$pcm"}}""") as ServerFrame.Audio
      val b = NativeCallProtocol.decode("""{"type":"call.event","peer":"p1","from":"u1","name":"audio","payload":{"seq":0,"pcm":"$pcm"}}""") as ServerFrame.Audio
      eq(1000000L, a.seq)
      eq(0L, b.seq)
    }
    case("custom relay keeps payload opaque") {
      val frame = NativeCallProtocol.decode(
        """{"type":"call.event","peer":"p1","from":"u2","name":"screen","payload":{"k":[1,"two",null]}}""",
      ) as ServerFrame.Relay
      eq("screen", frame.name)
      eq("""{"k":[1,"two",null]}""", frame.payload.toString())
    }
    case("remote error codes: known pass through, sentinel never reaches typed Error") {
      eq("peer_in_use", (NativeCallProtocol.decode("""{"type":"error","code":"peer_in_use"}""") as ServerFrame.Error).code)
      eq("not_in_call", (NativeCallProtocol.decode("""{"type":"error","code":"not_in_call"}""") as ServerFrame.Error).code)
      eq("invalid_link", (NativeCallProtocol.decode("""{"type":"error","code":"invalid_link"}""") as ServerFrame.Error).code)
      val sentinel = "https://evil.example/?token=SECRET_SENTINEL_123"
      val payloadLike = "{\\\"auth\\\":\\\"SECRET_SENTINEL_456\\\"}"
      val cases = listOf(
        """{"type":"error","code":"$sentinel"}""",
        """{"type":"error","code":"${sentinel.lowercase()}"}""",
        """{"type":"error","code":"peer_in_use SECRET_SENTINEL_789"}""",
        """{"type":"error","code":"$payloadLike"}""",
        """{"type":"error","code":"unknown_code_xyz"}""",
        """{"type":"error","code":""}""",
        """{"type":"error","code":null}""",
        """{"type":"error","code":42}""",
        """{"type":"error","code":{"nested":"SECRET_SENTINEL_000"}}""",
        """{"type":"error"}""",
      )
      for (c in cases) {
        val code = (NativeCallProtocol.decode(c) as ServerFrame.Error).code
        yes(code == "server_error", "unknown code leaked through: $c -> $code")
        yes(!code.contains("SECRET_SENTINEL") && !code.contains("evil"), "sentinel in code")
      }
    }
    case("kicked, error, pong, unknown") {
      eq("u9", (NativeCallProtocol.decode("""{"type":"call.kicked","by":"u9"}""") as ServerFrame.Kicked).by)
      eq("ws_only", (NativeCallProtocol.decode("""{"type":"error","client_id":null,"code":"ws_only","message":"m"}""") as ServerFrame.Error).code)
      yes(NativeCallProtocol.decode("""{"type":"pong"}""") is ServerFrame.Pong, "pong")
      yes(NativeCallProtocol.decode("""{"type":"message.created","client_id":null,"message":{}}""") is ServerFrame.Other, "unknown")
    }
    case("malformed known frames are protocol errors") {
      eq("bad_json", codeOf { NativeCallProtocol.decode("{") })
      eq("bad_frame", codeOf { NativeCallProtocol.decode("[1]") })
      eq("bad_members", codeOf { NativeCallProtocol.decode("""{"type":"call.state"}""") })
      eq("bad_by", codeOf { NativeCallProtocol.decode("""{"type":"call.kicked"}""") })
      eq("frame_too_large", codeOf { NativeCallProtocol.decode("x".repeat(NativeCallLimits.MAX_INCOMING_FRAME_CHARS + 1)) })
    }
  }

  private fun startControlArgs() {
    case("start args: flat object, all fields") {
      val a = NativeCallProtocol.parseStartArgs(startJson())
      eq("abc-123", a.session)
      eq("u1", a.expectedUserId)
      eq(null, a.devUser)
      eq(0.5, a.settings.outVolume)
      eq(-6.0, a.settings.limitDb)
      eq(null, a.settings.outputId)
      eq(listOf("p2"), a.localMuted)
    }
    case("start args: mic 0..2 and out 0..1 boundaries are inclusive") {
      eq(2.0, NativeCallProtocol.parseStartArgs(startJson(micVolume = "2")).settings.micVolume)
      eq(0.0, NativeCallProtocol.parseStartArgs(startJson(micVolume = "0")).settings.micVolume)
      eq(1.0, NativeCallProtocol.parseStartArgs(startJson(outVolume = "1")).settings.outVolume)
      eq(0.0, NativeCallProtocol.parseStartArgs(startJson(outVolume = "0")).settings.outVolume)
    }
    case("start args: out-of-range volumes are refused, not clamped") {
      eq("bad_volume", codeOf { NativeCallProtocol.parseStartArgs(startJson(micVolume = "2.01")) })
      eq("bad_volume", codeOf { NativeCallProtocol.parseStartArgs(startJson(micVolume = "-0.1")) })
      eq("bad_volume", codeOf { NativeCallProtocol.parseStartArgs(startJson(outVolume = "1.01")) })
      eq("bad_volume", codeOf { NativeCallProtocol.parseStartArgs(startJson(outVolume = "1.5")) })
    }
    case("start args: limitDb -18..-3 inclusive, outside refused") {
      eq(-18.0, NativeCallProtocol.parseStartArgs(startJson(limitDb = "-18")).settings.limitDb)
      eq(-3.0, NativeCallProtocol.parseStartArgs(startJson(limitDb = "-3")).settings.limitDb)
      eq("bad_limit", codeOf { NativeCallProtocol.parseStartArgs(startJson(limitDb = "-18.1")) })
      eq("bad_limit", codeOf { NativeCallProtocol.parseStartArgs(startJson(limitDb = "0")) })
    }
    case("start args: session, dev user, top-level shape validation") {
      eq("bad_session", codeOf { NativeCallProtocol.parseStartArgs(startJson(session = "a b")) })
      eq("bad_session", codeOf { NativeCallProtocol.parseStartArgs(startJson(session = "x".repeat(49))) })
      eq("bad_dev_user", codeOf { NativeCallProtocol.parseStartArgs(startJson(devUser = "\"æ\"")) })
      eq("bad_json", codeOf { NativeCallProtocol.parseStartArgs("[]") })
      eq("bad_json", codeOf { NativeCallProtocol.parseStartArgs("{") })
    }
    case("parseSession and stop args") {
      eq("abc-123", NativeCallProtocol.parseSession("""{"session":"abc-123"}"""))
      eq("bad_session", codeOf { NativeCallProtocol.parseSession("""{"session":"no good"}""") })
      eq(NativeCallStopArgs("abc-123", "user"), NativeCallProtocol.parseStopArgs("""{"session":"abc-123","reason":"user"}"""))
    }
    case("emit args: session, name, payload; audio refused") {
      val e = NativeCallProtocol.parseEmitArgs("""{"session":"abc-123","name":"screen","payload":{"n":1}}""")
      eq("abc-123", e.session)
      eq("screen", e.name)
      eq("""{"n":1}""", e.payload.toString())
      eq("reserved_event", codeOf { NativeCallProtocol.parseEmitArgs("""{"session":"abc-123","name":"audio","payload":{}}""") })
      eq("bad_payload", codeOf { NativeCallProtocol.parseEmitArgs("""{"session":"abc-123","name":"x"}""") })
    }
    case("control args: session plus partial patch") {
      val c = NativeCallProtocol.parseControlArgs("""{"session":"abc-123","patch":{"muted":true}}""")
      eq("abc-123", c.session)
      eq(true, c.patch.muted)
      eq(null, c.patch.deafened)
      eq(null, c.patch.settings)
    }
    case("control patch: partial fields, output clear vs unchanged") {
      val muted = NativeCallProtocol.parseControlPatch("""{"patch":{"muted":true}}""")
      eq(true, muted.muted)
      eq(null, muted.settings)
      val clear = NativeCallProtocol.parseControlPatch("""{"patch":{"settings":{"outputId":null,"micVolume":0.5}}}""")
      eq(OutputIdPatch(null), clear.settings!!.outputId)
      eq(0.5, clear.settings!!.micVolume)
      eq(null, clear.settings!!.outVolume)
      eq(null, NativeCallProtocol.parseControlPatch("""{"patch":{"settings":{"limiter":false}}}""").settings!!.outputId)
      eq(NativeCallPeerMute("p1", true), NativeCallProtocol.parseControlPatch("""{"patch":{"peerMute":{"peer":"p1","muted":true}}}""").peerMute)
      eq("bad_patch", codeOf { NativeCallProtocol.parseControlPatch("{}") })
      eq("invalid_peer", codeOf { NativeCallProtocol.parseControlPatch("""{"patch":{"peerMute":{"peer":"x y","muted":true}}}""") })
    }
    case("control patch: volume ranges apply to patches too") {
      eq("bad_volume", codeOf { NativeCallProtocol.parseControlPatch("""{"patch":{"settings":{"micVolume":2.5}}}""") })
      eq("bad_volume", codeOf { NativeCallProtocol.parseControlPatch("""{"patch":{"settings":{"outVolume":1.2}}}""") })
      eq("bad_limit", codeOf { NativeCallProtocol.parseControlPatch("""{"patch":{"settings":{"limitDb":-2}}}""") })
    }
    case("kick args") {
      eq(Pair("abc-123", "p9"), NativeCallProtocol.parseKickArgs("""{"session":"abc-123","peer":"p9"}"""))
    }
  }

  private fun eventsAndUrl() {
    case("snapshot wire keys: members use user_id, phase lowercase, error null") {
      val node = mapper.readTree(NativeCallProtocol.snapshotJson(snapshot))
      eq("joined", node.get("phase").asText())
      eq("u1", node.get("members").get(0).get("user_id").asText())
      yes(!node.get("members").get(0).has("userId"), "userId must not appear")
      yes(node.get("error").isNull, "error null")
      yes(node.get("serverUrl").isNull, "serverUrl null")
      eq(true, node.get("speaking").get("p1").asBoolean())
    }
    case("error.by only when known") {
      val kicked = snapshot.copy(error = NativeCallError("kicked", "removed", by = "u9"))
      eq("u9", mapper.readTree(NativeCallProtocol.snapshotJson(kicked)).get("error").get("by").asText())
      yes(!mapper.readTree(NativeCallProtocol.snapshotJson(snapshot.copy(error = NativeCallError("x", "y")))).get("error").has("by"), "no by")
    }
    case("event envelopes: state and relay") {
      val st = mapper.readTree(NativeCallProtocol.eventJson(NativeCallEvent.State(snapshot)))
      eq("state", st.get("kind").asText())
      eq(42L, st.get("snapshot").get("seq").asLong())
      val rel = mapper.readTree(
        NativeCallProtocol.eventJson(NativeCallEvent.Relay(NativeCallRelay("abc-123", 3, 43, "p1", "u2", "screen", mapper.readTree("""{"k":1}""")))),
      )
      eq("relay", rel.get("kind").asText())
      eq(1, rel.get("payload").get("k").asInt())
      eq("screen", rel.get("name").asText())
    }
    case("wsUrl mapping") {
      eq("ws://100.1.2.3:8080/api/ws", NativeCallProtocol.wsUrl("http://100.1.2.3:8080"))
      eq("wss://host.ts.net/api/ws", NativeCallProtocol.wsUrl("https://host.ts.net/"))
      eq("ws://h/api/ws", NativeCallProtocol.wsUrl("HTTP://h"))
      eq("bad_server_url", codeOf { NativeCallProtocol.wsUrl("ftp://h") })
      eq("bad_server_url", codeOf { NativeCallProtocol.wsUrl("h:8080") })
    }
  }
}
