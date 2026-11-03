package dev.disnans.screen

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger

/** 中継の入り口（本番のクラス RelayInbox）のテスト。上限と、起こす回数（合わせて 1 つ）を確かめる */
class RelayInboxTest {
  @Test fun afterClosingOnlyTheOffStateMayBeEmitted() {
    val inbox = RelayInbox()
    assertTrue(inbox.mayEmit(false))
    inbox.close()
    assertFalse(inbox.mayEmit(false))
    assertTrue(inbox.mayEmit(true))
  }


  @Test fun frameSlotHoldsOnlyTheLatestFrameAndCountsTheReplaced() {
    val inbox = RelayInbox()
    var wakes = 0
    repeat(10_000) { i -> if (inbox.offerFrame("f$i")) wakes++ }
    assertEquals("only one wake while nothing took the batch", 1, wakes)
    assertEquals(9_999L, inbox.replaced)
    val b = inbox.take()
    assertNotNull(b)
    assertEquals("f9999", b!!.frame)
    assertNull(b.members)
    assertNull(b.query)
  }

  @Test fun takeReArmsTheWakeAndNothingIsLeftAfterwards() {
    val inbox = RelayInbox()
    assertTrue(inbox.offerFrame("a"))
    assertFalse(inbox.offerFrame("b"))
    assertEquals("b", inbox.take()!!.frame)
    assertNull(inbox.take())
    assertTrue("a take re-arms the wake", inbox.offerFrame("c"))
  }

  @Test fun membersAndQueryAreCoalescedNotQueued() {
    val inbox = RelayInbox()
    assertTrue(inbox.offerMembers(setOf("a")))
    assertFalse(inbox.offerMembers(setOf("a", "b")))
    assertFalse(inbox.offerQuery("s1", 1))
    assertFalse(inbox.offerQuery("s1", 2))
    val b = inbox.take()!!
    assertEquals(setOf("a", "b"), b.members)
    assertEquals(Pair("s1", 2L), b.query)
    assertNull(b.frame)
  }

  @Test fun closeDropsPendingAndIgnoresLaterOffers() {
    val inbox = RelayInbox()
    inbox.offerFrame("pending")
    inbox.offerMembers(setOf("a"))
    inbox.close()
    assertTrue(inbox.isClosed)
    assertFalse(inbox.offerFrame("late"))
    assertFalse(inbox.offerMembers(setOf("b")))
    assertFalse(inbox.offerQuery("s", 1))
    assertNull(inbox.take())
  }

  @Test fun concurrentOffersStayBoundedAndTheLastFrameSurvives() {
    val inbox = RelayInbox()
    val threads = 4
    val perThread = 5_000
    val start = CountDownLatch(1)
    val wakes = AtomicInteger(0)
    val workers = (0 until threads).map { t ->
      Thread {
        start.await()
        for (i in 0 until perThread) {
          if (inbox.offerFrame("t$t-$i")) wakes.incrementAndGet()
        }
      }
    }
    workers.forEach { it.start() }
    start.countDown()
    workers.forEach { it.join() }
    val b = inbox.take()
    assertNotNull(b)
    // 一度も取り出さないあいだは、最初の 1 枚以外はすべて押し出し（捨て）になる
    assertEquals(threads * perThread - 1L, inbox.replaced)
    assertTrue("wakes stay far below offers (bounded)", wakes.get() < threads * perThread / 10)
  }

  // ---- 入り口から中継まで（本番の RelayInbox と ShareRelay を、偽の窓口で動かす） ----

  private class Port : RelayPort {
    val binding = RelayBinding("s", 1L, joined = true, listed = true, wanted = true)
    val sent = ArrayList<Pair<String, String>>()
    override fun binding(): BindingRead = BindingRead.Call(binding)
    override fun emit(b: RelayBinding, name: String, payloadJson: String): RelayEmit {
      sent.add(Pair(name, payloadJson))
      return RelayEmit(true)
    }
    override fun queuedBytes(): Long? = 0L
    override fun onOversize() {}
    override fun onEnded(code: String) {}
    fun frames(): List<String> = sent.filter { it.first == "screen.frame" }.map { it.second }
  }

  private fun stepUntilIdle(relay: ShareRelay) {
    var t = 0L
    repeat(200) {
      val d = relay.step(t)
      if (d < 0) return
      t += d
    }
  }

  private fun relayFor(port: Port): ShareRelay {
    val config = (RelayConfig.parse("screen.frame", "screen.state", "screen.query", emptyMap()) as RelayParse.Ok).config
    val relay = ShareRelay(config, 5, port, FrameIdAllocator(1_700_000_000_000L))
    relay.start(port.binding, 0L, emptySet())
    return relay
  }

  @Test fun drainedBatchSendsOnlyTheLatestFrame() {
    val inbox = RelayInbox()
    val port = Port()
    val relay = relayFor(port)
    var wakes = 0
    repeat(1_000) { i -> if (inbox.offerFrame("img$i")) wakes++ }
    assertEquals(1, wakes)
    relay.apply(inbox.take(), 0L)
    stepUntilIdle(relay)
    // 最新の 1 枚だけが送られる（キープアライブで同じ 1 枚を送り直すのは可）
    val sentImages = port.frames().map { p -> p.substringAfter("\"d\":\"").substringBefore("\"") }.distinct()
    assertEquals(listOf("img999"), sentImages)
  }

  @Test fun closedInboxDeliversNothingEvenWithPendingWork() {
    val inbox = RelayInbox()
    val port = Port()
    val relay = relayFor(port)
    inbox.offerFrame("late")
    inbox.close()
    relay.apply(inbox.take(), 0L)
    assertTrue(port.frames().isEmpty())
  }

  @Test fun memberChangeInTheBatchReannouncesState() {
    val inbox = RelayInbox()
    val port = Port()
    val relay = relayFor(port)
    relay.step(0L)
    val before = port.sent.count { it.first == "screen.state" }
    assertTrue(inbox.offerMembers(setOf("a", "b")))
    relay.apply(inbox.take(), 10L)
    relay.step(10L)
    assertTrue(port.sent.count { it.first == "screen.state" } > before)
  }

  // ---- 始める門（時間切れのあとに、遅れて始まらない） ----

  @Test fun abandonedGateNeverRunsTheStart() {
    val gate = ActivationGate()
    assertFalse("nothing was started, so no stop is needed", gate.abandon())
    var ran = false
    assertFalse(gate.activate { ran = true; true })
    assertFalse("the start must not run after abandonment", ran)
    assertFalse(gate.isActivated)
  }

  @Test fun activationRunsOnceAndAbandonAfterItReportsStop() {
    val gate = ActivationGate()
    var runs = 0
    assertTrue(gate.activate { runs++; true })
    assertFalse(gate.activate { runs++; true })
    assertEquals(1, runs)
    assertTrue("already started, so the caller must stop it", gate.abandon())
  }

  @Test fun failedStartLeavesTheGateInactive() {
    val gate = ActivationGate()
    assertFalse(gate.activate { false })
    assertFalse(gate.isActivated)
    assertFalse(gate.abandon())
  }
}
