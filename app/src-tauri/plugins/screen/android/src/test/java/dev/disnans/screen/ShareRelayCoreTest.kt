package dev.disnans.screen

import com.fasterxml.jackson.databind.ObjectMapper
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 画面の中継の純粋な部分のテスト（偽の窓口・偽の時計）。UI のコールバックも、実物の通話も使わない。
 * 受け手の組み立ては、JS の FrameAssembler で確かめた fixture（relay_chunks_fixture.json）と突き合わせる。
 */
class ShareRelayCoreTest {
  @Test fun frameIdsFollowTheClockAndNeverGoBackAcrossEncoderSwitches() {
    var clock = 100L
    val ids = FrameIdAllocator(10L) { clock }
    assertEquals(100L, ids.next())
    // JS のカメラへ替わってからネイティブへ戻っても、古い小さなカウンターを出さない。
    clock = 10_000L
    assertEquals(10_000L, ids.next())
    clock = 50L
    assertEquals(10_001L, ids.next())
  }


  /** 偽の窓口。送った内容を記録し、通話の状態と送信待ちの量を外から動かす */
  private class FakePort : RelayPort {
    var bind: RelayBinding? = null
    var unavailable = false
    /** null は読めなかった（送らずに待つ） */
    var queued: Long? = 0L
    var refuseFrom = Int.MAX_VALUE
    var clock = 0L
    val sent = ArrayList<Sent>()
    var oversize = 0
    val ended = ArrayList<String>()
    private var frameEmits = 0

    class Sent(val at: Long, val name: String, val payload: String)

    override fun binding(): BindingRead =
      if (unavailable) BindingRead.Unavailable else bind?.let { BindingRead.Call(it) } ?: BindingRead.NoCall

    override fun emit(b: RelayBinding, name: String, payloadJson: String): RelayEmit {
      if (name == FRAME) frameEmits++
      if (name == FRAME && frameEmits >= refuseFrom) return RelayEmit(false, "queue_full")
      sent.add(Sent(clock, name, payloadJson))
      return RelayEmit(true)
    }

    override fun queuedBytes(): Long? = queued
    override fun onOversize() {
      oversize++
    }

    override fun onEnded(code: String) {
      ended.add(code)
    }

    fun frames(): List<Sent> = sent.filter { it.name == FRAME }
    fun states(): List<Sent> = sent.filter { it.name == STATE }
  }

  companion object {
    const val FRAME = "screen.frame"
    const val STATE = "screen.state"
    const val QUERY = "screen.query"
    const val SESSION = "s-one"
    const val WALL = 1_700_000_000_000L

    fun names(query: String? = QUERY) = RelayConfig.parse(FRAME, STATE, query, mapOf("source" to "screen"))
      .let { (it as RelayParse.Ok).config }

    fun active(session: String = SESSION, gen: Long = 1L) = RelayBinding(session, gen, joined = true, listed = true, wanted = true)

    /** 決まった base64（テストの再現のため。fixture と同じ生成） */
    fun gen(n: Int, seed: Long = 12345L): String {
      val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
      var x = seed
      val sb = StringBuilder(n)
      repeat(n) {
        x = x * 6364136223846793005L + 1442695040888963407L
        sb.append(alphabet[((x ushr 33) % 64).toInt()])
      }
      return sb.toString()
    }
  }

  /** 時計を進めながら、step を呼ぶ（返り値の分だけ待つ）。offer は時刻ごとに呼び出し側が行う */
  private fun run(relay: ShareRelay, port: FakePort, fromMs: Long, toMs: Long, onTick: (Long) -> Unit = {}) {
    var t = fromMs
    while (t < toMs) {
      port.clock = t
      onTick(t)
      val d = relay.step(t)
      if (d < 0) return
      // 0 は同じ時刻で続ける（かけらを 1 つずつ送る）。待つときは正の値
      t += d
    }
  }

  // ---- 始め方・止め方 ----

  @Test fun startRequiresAnActiveCall() {
    val relay = ShareRelay(names(), 5, FakePort())
    assertFalse(relay.start(active().copy(joined = false), 0, emptySet()))
    assertFalse(relay.start(active().copy(listed = false), 0, emptySet()))
    assertFalse(relay.start(active().copy(wanted = false), 0, emptySet()))
    assertFalse(relay.isRunning)
    assertTrue(relay.start(active(), 0, emptySet()))
    assertTrue(relay.isRunning)
  }

  @Test fun finalCallEndsWithoutOffAndNeverRestarts() {
    val port = FakePort()
    val relay = ShareRelay(names(), 5, port)
    port.bind = active()
    relay.start(active(), 0, emptySet())
    relay.offer(gen(100), 0)
    run(relay, port, 0, 500)
    port.bind = null
    assertEquals(-1L, relay.step(1_000))
    assertEquals(listOf("call_ended"), port.ended)
    assertFalse(port.sent.any { it.payload == RelayConfig.OFF_STATE_JSON })
    val before = port.sent.size
    relay.offer(gen(100), 2_000)
    assertEquals(-1L, relay.step(3_000))
    assertEquals(before, port.sent.size)
  }

  @Test fun sessionOrGenerationChangeEndsTheRelay() {
    val port = FakePort()
    val relay = ShareRelay(names(), 5, port)
    port.bind = active()
    relay.start(active(), 0, emptySet())
    port.bind = active(session = "other")
    assertEquals(-1L, relay.step(10))
    assertEquals(listOf("call_changed"), port.ended)

    val p2 = FakePort()
    val r2 = ShareRelay(names(), 5, p2)
    p2.bind = active(gen = 1)
    r2.start(active(gen = 1), 0, emptySet())
    p2.bind = active(gen = 2)
    assertEquals(-1L, r2.step(10))
    assertEquals(listOf("call_changed"), p2.ended)
  }

  @Test fun wantedFalseEndsAsCallStopped() {
    val port = FakePort()
    val relay = ShareRelay(names(), 5, port)
    port.bind = active()
    relay.start(active(), 0, emptySet())
    port.bind = active().copy(wanted = false)
    assertEquals(-1L, relay.step(10))
    assertEquals(listOf("call_stopped"), port.ended)
  }

  @Test fun explicitStopSendsOffOnceWhileTheCallIsStillListed() {
    val port = FakePort()
    val relay = ShareRelay(names(), 5, port)
    port.bind = active()
    relay.start(active(), 0, emptySet())
    relay.stop("user_stop")
    relay.stop("user_stop")
    assertEquals(listOf("user_stop"), port.ended)
    assertEquals(1, port.sent.count { it.payload == RelayConfig.OFF_STATE_JSON })
  }

  @Test fun recoveringCallPausesWithoutEndingAndResumesWithStateAndLatest() {
    val port = FakePort()
    val relay = ShareRelay(names(), 5, port)
    port.bind = active()
    relay.start(active(), 0, emptySet())
    relay.offer(gen(200), 0)
    run(relay, port, 0, 500)
    val sentBefore = port.frames().size
    val lastBefore = port.frames().last().payload

    port.bind = active().copy(listed = false)
    val pausedAt = 1_000L
    run(relay, port, pausedAt, 5_000)
    assertTrue(relay.isRunning)
    assertEquals(sentBefore, port.frames().size)
    assertTrue(port.ended.isEmpty())
    assertEquals(1L, relay.counters.get(RelayCount.PAUSED))

    port.bind = active()
    port.clock = 5_000
    relay.step(5_000)
    run(relay, port, 5_000, 6_000)
    assertTrue(port.frames().size > sentBefore)
    val resent = port.frames().last()
    assertTrue(lastBefore.isNotEmpty() && resent.payload.contains("\"d\":\""))
    assertTrue(relay.counters.get(RelayCount.STATE_SENT) > 0)
  }

  // ---- 送る中身 ----

  @Test fun everyChunkStaysWithinTheLimitsAndFrameIdsIncrease() {
    val port = FakePort()
    val relay = ShareRelay(names(), 5, port)
    port.bind = active()
    relay.start(active(), 0, emptySet())
    relay.offer(gen(RelayLimits.MAX_FRAME_CHARS), 0)
    run(relay, port, 0, 2_000)
    relay.offer(gen(30_000, seed = 7L), 2_000)
    run(relay, port, 2_000, 4_000)
    val mapper = ObjectMapper()
    var lastF = 0L
    for (fr in port.frames()) {
      val p = mapper.readTree(fr.payload)
      assertTrue(p.get("n").asInt() in 1..RelayLimits.MAX_CHUNKS)
      assertTrue(p.get("d").asText().length <= RelayLimits.CHUNK_CHARS)
      if (p.get("i").asInt() == 0) {
        assertTrue(p.get("f").asLong() > lastF)
        lastF = p.get("f").asLong()
      }
    }
    assertEquals(0, port.oversize)
  }

  @Test fun reassemblyMatchesTheJsFixture() {
    val port = FakePort()
    val relay = ShareRelay(names(), 5, port, FrameIdAllocator(WALL))
    port.bind = active()
    relay.start(active(), 0, emptySet())
    val data = gen(20_000)
    relay.offer(data, 0)
    run(relay, port, 0, 1_000)

    val fixtureText = javaClass.getResource("/relay_chunks_fixture.json")!!.readText()
    val fixture = ObjectMapper().readTree(fixtureText)
    val first = fixture.get("frames")[0]
    assertEquals(data.length.toLong(), first.get("len").asLong())
    val got = port.frames().map { it.payload }.take(first.get("chunks").size())
    val want = (0 until first.get("chunks").size()).map { first.get("chunks")[it].asText() }
    assertEquals(want, got)
    assertEquals(first.get("f").asLong(), ObjectMapper().readTree(got[0]).get("f").asLong())
  }

  @Test fun replacementKeepsOnlyTheLatestFrame() {
    val port = FakePort()
    val relay = ShareRelay(names(), 5, port)
    port.bind = active()
    relay.start(active(), 0, emptySet())
    relay.step(0)
    port.queued = 9_000
    for (i in 0 until 10) relay.offer(gen(100, seed = i.toLong() + 1), 0)
    port.queued = 0L
    run(relay, port, 0, 500)
    assertEquals(9L, relay.counters.get(RelayCount.DROPPED_REPLACED))
    val payloads = port.frames().map { it.payload }
    val expected = gen(100, seed = 10L)
    assertTrue(payloads.last().contains(expected))
  }

  @Test fun oversizeFrameIsDroppedAndAsksForLowerQualityOncePerGap() {
    val port = FakePort()
    val relay = ShareRelay(names(), 5, port)
    port.bind = active()
    relay.start(active(), 0, emptySet())
    val big = "A".repeat(RelayLimits.MAX_FRAME_CHARS + 1)
    relay.offer(big, 0)
    relay.offer(big, 100)
    relay.offer(big, 3_000)
    assertEquals(2, port.oversize)
    assertEquals(3L, relay.counters.get(RelayCount.DROPPED_OVERSIZE))
    run(relay, port, 0, 500)
    assertTrue(port.frames().isEmpty())
  }

  @Test fun invalidBase64IsDropped() {
    val port = FakePort()
    val relay = ShareRelay(names(), 5, port)
    port.bind = active()
    relay.start(active(), 0, emptySet())
    relay.offer("abc\"def", 0)
    relay.offer("", 0)
    assertEquals(2L, relay.counters.get(RelayCount.DROPPED_INVALID))
    run(relay, port, 0, 300)
    assertTrue(port.frames().isEmpty())
  }

  @Test fun queueAboveTheLimitHoldsChunksUntilItDrains() {
    val port = FakePort()
    val relay = ShareRelay(names(), 5, port)
    port.bind = active()
    relay.start(active(), 0, emptySet())
    port.queued = RelayLimits.QUEUE_LIMIT_BYTES + 1
    relay.offer(gen(20_000), 0)
    run(relay, port, 0, 1_000)
    assertTrue(port.frames().isEmpty())
    assertTrue(relay.counters.get(RelayCount.QUEUE_WAIT) > 0)
    port.queued = 0L
    run(relay, port, 1_000, 2_000)
    assertEquals(3, port.frames().size)
  }

  @Test fun refusedChunkDropsThePartialFrameWithoutReplay() {
    val port = FakePort()
    val relay = ShareRelay(names(), 5, port)
    port.bind = active()
    relay.start(active(), 0, emptySet())
    relay.offer(gen(20_000), 0)
    port.refuseFrom = 2
    run(relay, port, 0, 1_000)
    assertEquals(1, port.frames().size)
    assertEquals(1L, relay.counters.get(RelayCount.DROPPED_REFUSED))
  }

  @Test fun partialFrameExpiresWhenTheQueueStaysBlocked() {
    val port = FakePort()
    val relay = ShareRelay(names(), 5, port)
    port.bind = active()
    relay.start(active(), 0, emptySet())
    relay.offer(gen(20_000), 0)
    // 最初のかけらだけを送る（状態の送信のあと、1 つ目）
    relay.step(0)
    val sentFirst = port.frames().size
    assertEquals(1, sentFirst)
    port.queued = RelayLimits.QUEUE_LIMIT_BYTES + 1
    run(relay, port, 10, 3_000)
    assertEquals(1L, relay.counters.get(RelayCount.DROPPED_EXPIRED))
    port.queued = 0L
    run(relay, port, 3_000, 4_000)
    assertEquals(sentFirst, port.frames().size)
  }

  // ---- 長い時間・問い合わせ・人の出入り ----

  @Test fun sixMinutesOfFrozenUiKeepsHeartbeatAndFramesFlowing() {
    val port = FakePort()
    val relay = ShareRelay(names(), 5, port)
    port.bind = active()
    relay.start(active(), 0, emptySet())
    val end = 6 * 60 * 1000L
    var nextOffer = 0L
    run(relay, port, 0, end) { t ->
      if (t >= nextOffer) {
        relay.offer(gen(4_000, seed = t), t)
        nextOffer = t + 500L
      }
    }
    val states = port.states()
    assertTrue("heartbeat count ${states.size}", states.size >= (end / 3000L).toInt() - 2)
    val gaps = states.zipWithNext { a, b -> b.at - a.at }
    assertTrue("state gap max ${gaps.maxOrNull()}", gaps.all { it <= 3_100L })
    assertTrue(port.frames().size > 100)
    assertEquals(0L, relay.counters.get(RelayCount.DROPPED_INVALID))
  }

  @Test fun queryRepliesWithStateAndLatestFrameFromTheSameCallOnly() {
    val port = FakePort()
    val relay = ShareRelay(names(), 5, port)
    port.bind = active()
    relay.start(active(), 0, emptySet())
    relay.offer(gen(300), 0)
    run(relay, port, 0, 500)
    val before = port.sent.size
    relay.onQuery("other", 1)
    relay.onQuery(SESSION, 9)
    relay.onQuery(SESSION, 1)
    run(relay, port, 500, 600)
    assertEquals(1L, relay.counters.get(RelayCount.QUERY))
    assertTrue(port.sent.size > before)
    assertTrue(port.sent.drop(before).any { it.name == STATE })
    assertTrue(port.sent.drop(before).any { it.name == FRAME })
  }

  @Test fun memberChangeReannouncesStateAndLatest() {
    val port = FakePort()
    val relay = ShareRelay(names(), 5, port)
    port.bind = active()
    relay.start(active(), 0, setOf("a"))
    relay.offer(gen(300), 0)
    run(relay, port, 0, 500)
    val before = port.sent.size
    relay.onMembers(setOf("a"))
    assertEquals(0L, relay.counters.get(RelayCount.MEMBER_ANNOUNCE))
    relay.onMembers(setOf("a", "b"))
    assertEquals(1L, relay.counters.get(RelayCount.MEMBER_ANNOUNCE))
    run(relay, port, 500, 600)
    assertTrue(port.sent.drop(before).any { it.name == STATE })
    assertTrue(port.sent.drop(before).any { it.name == FRAME })
  }

  @Test fun keepaliveResendsTheLastFrameWithANewFrameId() {
    val port = FakePort()
    val relay = ShareRelay(names(), 5, port)
    port.bind = active()
    relay.start(active(), 0, emptySet())
    relay.offer(gen(300), 0)
    run(relay, port, 0, 500)
    val first = port.frames().last()
    run(relay, port, 500, 6_000)
    assertTrue(relay.counters.get(RelayCount.KEEPALIVE) >= 1)
    val again = port.frames().last()
    assertEquals(first.payload.substringAfter("\"d\":"), again.payload.substringAfter("\"d\":"))
    assertTrue(ObjectMapper().readTree(again.payload).get("f").asLong() > ObjectMapper().readTree(first.payload).get("f").asLong())
  }

  @Test fun onlyTheFrameAndStateNamesAreEverEmitted() {
    val port = FakePort()
    val relay = ShareRelay(names(), 5, port)
    port.bind = active()
    relay.start(active(), 0, emptySet())
    relay.offer(gen(3_000), 0)
    run(relay, port, 0, 1_000)
    relay.stop("user_stop")
    assertTrue(port.sent.isNotEmpty())
    assertTrue(port.sent.all { it.name == FRAME || it.name == STATE })
  }

  @Test fun stateEventCarriesOnlyTheOnFlagAndExtraFields() {
    val port = FakePort()
    val relay = ShareRelay(names(), 5, port)
    port.bind = active()
    relay.start(active(), 0, emptySet())
    run(relay, port, 0, 10)
    assertEquals("{\"on\":true,\"source\":\"screen\"}", port.states().first().payload)
  }

  @Test fun frameIdsKeepIncreasingAcrossCapturesThatShareAnAllocator() {
    val ids = FrameIdAllocator(WALL)
    val p1 = FakePort()
    val r1 = ShareRelay(names(), 5, p1, ids)
    p1.bind = active()
    r1.start(active(), 0, emptySet())
    r1.offer(gen(100), 0)
    run(r1, p1, 0, 300)
    r1.stop("user_stop")
    val last1 = ObjectMapper().readTree(p1.frames().last().payload).get("f").asLong()

    val p2 = FakePort()
    val r2 = ShareRelay(names(), 5, p2, ids)
    p2.bind = active()
    r2.start(active(), 0, emptySet())
    r2.offer(gen(100), 0)
    run(r2, p2, 0, 300)
    val first2 = ObjectMapper().readTree(p2.frames().first().payload).get("f").asLong()
    assertTrue("second capture f=$first2 must exceed first capture f=$last1", first2 > last1)
  }

  @Test fun unavailableBindingPausesWithoutEndingOrClaimingCallEnded() {
    val port = FakePort()
    val relay = ShareRelay(names(), 5, port)
    port.bind = active()
    relay.start(active(), 0, emptySet())
    relay.offer(gen(100), 0)
    run(relay, port, 0, 300)
    val before = port.frames().size
    port.unavailable = true
    run(relay, port, 300, 3_000)
    assertTrue(relay.isRunning)
    assertTrue(port.ended.isEmpty())
    assertEquals(before, port.frames().size)
    assertTrue(relay.counters.get(RelayCount.BINDING_UNAVAILABLE) > 0)
    // 読めるようになったら、同じ通話なら続く（新しい画面は始めない）
    port.unavailable = false
    relay.offer(gen(100, seed = 9L), 3_000)
    run(relay, port, 3_000, 4_000)
    assertTrue(port.frames().size > before)
    assertTrue(port.ended.isEmpty())
  }

  @Test fun unknownQueueFailsClosedAndSendsNothing() {
    val port = FakePort()
    val relay = ShareRelay(names(), 5, port)
    port.bind = active()
    relay.start(active(), 0, emptySet())
    port.queued = null
    relay.offer(gen(20_000), 0)
    relay.step(0)
    run(relay, port, 10, 1_000)
    assertEquals(0, port.frames().size)
    assertTrue(relay.counters.get(RelayCount.QUEUE_UNKNOWN) > 0)
    assertTrue(port.ended.isEmpty())
  }

  @Test fun stateLimitCountsTheWholeJsonIncludingBraces() {
    // SDK と同じく追加項目 {"k":"..."} 全体を数える（固定の on はこの上限に含めない）。
    val exact = RelayConfig.parse(FRAME, STATE, null, mapOf("k" to "a".repeat(248)))
    assertTrue(exact is RelayParse.Ok)
    val extra = ObjectMapper().readTree((exact as RelayParse.Ok).config.onStateJson).deepCopy<com.fasterxml.jackson.databind.node.ObjectNode>()
    extra.remove("on")
    assertEquals(256, extra.toString().toByteArray(Charsets.UTF_8).size)
    val over = RelayConfig.parse(FRAME, STATE, null, mapOf("k" to "a".repeat(249)))
    assertEquals("state_too_large", (over as RelayParse.Err).code)
  }

  @Test fun emptyAndLongStateKeysAreAllowedWhileTheTotalFitsTheLimit() {
    assertTrue(RelayConfig.parse(FRAME, STATE, null, mapOf("" to "x")) is RelayParse.Ok)
    assertTrue(RelayConfig.parse(FRAME, STATE, null, mapOf("k".repeat(120) to 1)) is RelayParse.Ok)
  }

  // ---- 判断・間隔・画質（純粋な表） ----

  @Test fun nativeRelayDoesNotKeepTheWebViewAwake() {
    assertFalse(RelayPolicy.keepWebViewActive(false, true, true))
    assertTrue(RelayPolicy.keepWebViewActive(false, true, false))
    assertTrue(RelayPolicy.keepWebViewActive(true, true, true))
    assertFalse(RelayPolicy.keepWebViewActive(false, false, false))
  }

  @Test fun policyDecidesPreviewAndRevalidation() {
    assertTrue(RelayPolicy.deliverPreview(relayOn = false, previewVisible = false))
    assertTrue(RelayPolicy.deliverPreview(relayOn = true, previewVisible = true))
    assertFalse(RelayPolicy.deliverPreview(relayOn = true, previewVisible = false))
    assertTrue(RelayPolicy.previewVisible(resumed = false, inPip = true))
    assertFalse(RelayPolicy.previewVisible(resumed = false, inPip = false))

    val pending = active()
    fun call(b: RelayBinding) = BindingRead.Call(b)
    assertTrue(RelayPolicy.revalidate(pending, call(active())))
    assertFalse(RelayPolicy.revalidate(pending, BindingRead.NoCall))
    assertFalse(RelayPolicy.revalidate(pending, BindingRead.Unavailable))
    assertFalse(RelayPolicy.revalidate(pending, call(active(gen = 2))))
    assertFalse(RelayPolicy.revalidate(pending, call(active(session = "x"))))
    assertFalse(RelayPolicy.revalidate(pending, call(active().copy(listed = false))))
    assertTrue(RelayPolicy.startable(active()))
    assertFalse(RelayPolicy.startable(null))
  }

  @Test fun pacingFollowsFpsBudgetAndTheMaxDelay() {
    assertEquals(200L, RelayPacing.intervalMs(fps = 5, chunks = 1, b64Chars = 100))
    assertEquals(34L, RelayPacing.intervalMs(fps = 30, chunks = 1, b64Chars = 100))
    assertTrue(RelayPacing.intervalMs(fps = 30, chunks = 64, b64Chars = RelayLimits.MAX_FRAME_CHARS) <= RelayLimits.MAX_DELAY_MS)
    assertEquals(RelayLimits.MAX_DELAY_MS, RelayPacing.intervalMs(fps = 1, chunks = 64, b64Chars = 50_000_000))
  }

  @Test fun qualityLowersOneStepAtATimeAndStopsAtTheMinima() {
    var q = 1.0
    var s = 1.0
    var steps = 0
    while (true) {
      val next = RelayPacing.lowerQuality(q, s) ?: break
      q = next.first
      s = next.second
      steps++
      assertTrue(q >= RelayLimits.MIN_QUALITY - 1e-9)
      assertTrue(s >= RelayLimits.MIN_SCALE - 1e-9)
      assertTrue(steps < 100)
    }
    assertEquals(RelayLimits.MIN_QUALITY, q, 1e-9)
    assertEquals(RelayLimits.MIN_SCALE, s, 1e-9)
    assertNull(RelayPacing.lowerQuality(RelayLimits.MIN_QUALITY, RelayLimits.MIN_SCALE))
  }

  @Test fun countersPrintFixedNamesOnly() {
    val c = RelayCounters()
    c.inc(RelayCount.SENT_CHUNKS)
    val line = c.line()
    assertTrue(line.startsWith("produced=0 enqueued=0 sent_chunks=1"))
    assertFalse(line.contains("screen.frame"))
  }

  // ---- 要求の検査（画面を取得する前に決める） ----

  @Test fun configAcceptsTheDocumentedShape() {
    val r = RelayConfig.parse(FRAME, STATE, QUERY, mapOf("source" to "screen", "n" to 2, "f" to 1.5, "b" to true))
    assertTrue(r is RelayParse.Ok)
    assertEquals("{\"on\":true,\"source\":\"screen\",\"n\":2,\"f\":1.5,\"b\":true}", (r as RelayParse.Ok).config.onStateJson)
    assertEquals("{\"on\":false}", RelayConfig.OFF_STATE_JSON)
  }

  @Test fun configRejectsBadNamesDuplicatesAndReservedKeys() {
    fun code(r: RelayParse) = (r as RelayParse.Err).code
    assertEquals("bad_name", code(RelayConfig.parse(null, STATE, null, emptyMap())))
    assertEquals("bad_name", code(RelayConfig.parse("audio", STATE, null, emptyMap())))
    assertEquals("bad_name", code(RelayConfig.parse("", STATE, null, emptyMap())))
    assertEquals("bad_name", code(RelayConfig.parse("x".repeat(65), STATE, null, emptyMap())))
    assertEquals("duplicate_name", code(RelayConfig.parse(FRAME, FRAME, null, emptyMap())))
    assertEquals("duplicate_name", code(RelayConfig.parse(FRAME, STATE, STATE, emptyMap())))
    assertEquals("reserved_state_key", code(RelayConfig.parse(FRAME, STATE, null, mapOf("on" to true))))
    assertEquals("bad_state", code(RelayConfig.parse(FRAME, STATE, null, mapOf("x" to null))))
    assertEquals("bad_state", code(RelayConfig.parse(FRAME, STATE, null, mapOf("x" to Double.NaN))))
    assertEquals("bad_state", code(RelayConfig.parse(FRAME, STATE, null, mapOf("x" to listOf(1)))))
  }

  @Test fun stateSupportsFiniteLargeJsonNumbersAndWellFormedEscapes() {
    val r = RelayConfig.parse(FRAME, STATE, null, mapOf("number" to java.math.BigInteger("100000000000000000000"), "text" to "\n".repeat(100)))
    assertTrue(r is RelayParse.Ok)
    val json = ObjectMapper().readTree((r as RelayParse.Ok).config.onStateJson)
    assertEquals(1e20, json["number"].asDouble(), 0.0)
    assertEquals("\n".repeat(100), json["text"].asText())
    val lone = "\uD800"
    assertEquals("\"\\ud800\"", RelayConfig.jsonString(lone))
  }

  @Test fun configLimitsTheExtraStateTo256Bytes() {
    val ok = RelayConfig.parse(FRAME, STATE, null, mapOf("k" to "a".repeat(200)))
    assertTrue(ok is RelayParse.Ok)
    val big = RelayConfig.parse(FRAME, STATE, null, mapOf("k" to "a".repeat(260)))
    assertEquals("state_too_large", (big as RelayParse.Err).code)
  }

  @Test fun configEscapesStringsInTheStateJson() {
    val r = RelayConfig.parse(FRAME, STATE, null, mapOf("q" to "a\"b\\c\n"))
    val json = (r as RelayParse.Ok).config.onStateJson
    assertEquals("{\"on\":true,\"q\":\"a\\\"b\\\\c\\n\"}", json)
    assertNotNull(ObjectMapper().readTree(json))
  }


  // ---- callRelay の厳しい検査（型・未知の項目・null・配列） ----

  private fun fromRawCode(present: Boolean, value: Any?): String? =
    (RelayConfig.fromRaw(present, value) as? RelayParse.Err)?.code

  private fun validRaw(): Map<String, Any?> = linkedMapOf(
    "frameEvent" to "screen.frame",
    "stateEvent" to "screen.state",
    "queryEvent" to "screen.query",
    "state" to linkedMapOf<String, Any?>("source" to "screen"),
  )

  @Test fun absentCallRelayIsLegacyNotAnError() {
    assertTrue(RelayConfig.fromRaw(present = false, value = null) is RelayParse.Absent)
    assertTrue(RelayConfig.fromRaw(present = false, value = "anything") is RelayParse.Absent)
  }

  @Test fun presentButNotAnObjectIsRejectedNeverTreatedAsLegacy() {
    assertEquals("bad_relay", fromRawCode(true, null))
    assertEquals("bad_relay", fromRawCode(true, listOf(1, 2)))
    assertEquals("bad_relay", fromRawCode(true, "screen.frame"))
    assertEquals("bad_relay", fromRawCode(true, 1))
    assertEquals("bad_relay", fromRawCode(true, true))
  }

  @Test fun namesMustBeStringsAndAllRequiredNamesPresent() {
    assertEquals("bad_name", fromRawCode(true, validRaw() + ("frameEvent" to 5)))
    assertEquals("bad_name", fromRawCode(true, validRaw() + ("frameEvent" to null)))
    assertEquals("bad_name", fromRawCode(true, validRaw() + ("stateEvent" to listOf("x"))))
    assertEquals("bad_name", fromRawCode(true, validRaw() + ("queryEvent" to null)))
    assertEquals("bad_name", fromRawCode(true, validRaw().filterKeys { it != "stateEvent" }))
  }

  @Test fun stateMustBeAnObjectAndItsValuesPrimitive() {
    assertEquals("bad_state", fromRawCode(true, validRaw() + ("state" to listOf("screen"))))
    assertEquals("bad_state", fromRawCode(true, validRaw() + ("state" to null)))
    assertEquals("bad_state", fromRawCode(true, validRaw() + ("state" to "screen")))
    assertEquals("bad_state", fromRawCode(true, validRaw() + ("state" to linkedMapOf<String, Any?>("k" to listOf(1)))))
  }

  @Test fun unknownKeysAreRejected() {
    assertEquals("bad_relay", fromRawCode(true, validRaw() + ("extra" to "x")))
  }

  @Test fun validObjectParsesToTheOnStateJson() {
    val r = RelayConfig.fromRaw(true, validRaw())
    assertTrue(r is RelayParse.Ok)
    assertEquals("{\"on\":true,\"source\":\"screen\"}", (r as RelayParse.Ok).config.onStateJson)
  }
}
