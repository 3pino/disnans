package dev.disnans.screen

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 撮りの待ち（本番のクラス CaptureGate と CaptureStop）のテスト。呼び出しの同一性は、消す前に確かめる */
class CaptureGateTest {
  @Test fun staleServiceIntentCannotConsumeTheNewReservation() {
    val starts = CaptureStarts<String>()
    starts.reserve(1L, "old")
    assertTrue(starts.cancel(1L))
    starts.reserve(2L, "new")
    assertNull(starts.take(1L))
    assertFalse(starts.cancel(1L))
    assertEquals("new", starts.take(2L))
    assertNull(starts.take(2L))
  }

  @Test fun stoppingBeforeServiceDeliveryPreventsCapture() {
    val starts = CaptureStarts<String>()
    starts.reserve(5L, "capture")
    assertTrue(starts.cancel(5L))
    assertNull(starts.take(5L))
  }

  private class Call(val name: String)

  @Test fun onlyOnePendingRequestAtATime() {
    val gate = CaptureGate<Call, String>()
    val first = Call("first")
    assertTrue(gate.begin(first, 1L, "p1"))
    assertTrue(gate.isBusy())
    assertFalse("a second request is busy", gate.begin(Call("second"), 2L, "p2"))
    assertEquals(1L, gate.pendingId())
  }

  @Test fun takeWithAnotherInvokeConsumesNothing() {
    val gate = CaptureGate<Call, String>()
    val owner = Call("owner")
    gate.begin(owner, 7L, "payload")
    assertNull("a different invoke does not take", gate.take(Call("other")))
    assertTrue("the pending request is still there", gate.isBusy())
    val got = gate.take(owner)
    assertNotNull(got)
    assertEquals("payload", got!!.payload)
    assertEquals(7L, got.captureId)
    assertFalse(gate.isBusy())
  }

  @Test fun takeIsOnceOnlyAndTheGateReopens() {
    val gate = CaptureGate<Call, String>()
    val owner = Call("owner")
    gate.begin(owner, 1L, "a")
    assertNotNull(gate.take(owner))
    assertNull(gate.take(owner))
    assertTrue(gate.begin(Call("next"), 2L, "b"))
  }

  @Test fun cancelOnlyMatchingCaptureIdIncludingLegacyZero() {
    val gate = CaptureGate<Call, String>()
    gate.begin(Call("x"), 5L, "a")
    assertFalse("an old id does not cancel the new pending request", gate.cancelIf(4L))
    assertTrue(gate.isBusy())
    assertTrue(gate.cancelIf(5L))
    assertFalse(gate.isBusy())

    gate.begin(Call("legacy"), 0L, "b")
    assertFalse(gate.cancelIf(9L))
    assertTrue("a legacy pending request is cancelled by a legacy stop", gate.cancelIf(0L))
  }

  @Test fun clearDropsThePendingRequest() {
    val gate = CaptureGate<Call, String>()
    gate.begin(Call("x"), 3L, "a")
    gate.clear()
    assertFalse(gate.isBusy())
    assertNull(gate.pendingId())
  }

  @Test fun ownerAcceptsOnlyTheCurrentCaptureAndNeverAWildcardIntoAPositiveOne() {
    val owner = CaptureOwner()
    // 持ち主がいないとき、番号 0（旧い指示）は届く。正の番号は届かない
    assertTrue(owner.accepts(0L))
    assertFalse(owner.accepts(5L))
    // 待ちの時点で持ち主になる（撮りが始まる前から、その番号の指示が届く）
    owner.claim(5L)
    assertTrue(owner.accepts(5L))
    assertFalse("a zero id must not target a positive capture", owner.accepts(0L))
    assertFalse("an old id does not target the new capture", owner.accepts(4L))
    // 持ち主と同じ番号だけが手放せる
    assertFalse(owner.release(4L))
    assertTrue(owner.release(5L))
    assertNull(owner.current())
  }

  @Test fun legacyZeroOwnerStillReceivesLegacyZeroStops() {
    val owner = CaptureOwner()
    owner.claim(0L)
    assertTrue(owner.accepts(0L))
    assertFalse(owner.accepts(7L))
    owner.claim(7L)
    assertFalse("a legacy stop must not reach the new positive capture", owner.accepts(0L))
  }
}
