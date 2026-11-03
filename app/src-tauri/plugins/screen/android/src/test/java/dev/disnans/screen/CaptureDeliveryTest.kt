package dev.disnans.screen

import org.junit.Assert.assertEquals
import org.junit.Test

/** SDK 上で、実際の取得設定が使う配送を確認する（画像取得や Android の操作はしない）。 */
class CaptureDeliveryTest {
  private fun config(id: Long) = CaptureConfig(1280, 5, "jpeg", "full", 1.5, 5000, 0.6, captureId = id)
  private fun frame(id: Long) = CapturedFrame("QUJD", "image/jpeg", 2, 2, id)

  @Test fun oldCaptureNeverUsesTheNewCapturesSink() {
    val old = config(1)
    val fresh = config(2)
    var oldCount = 0
    var freshCount = 0
    old.relaySink = { oldCount++ }
    fresh.relaySink = { freshCount++ }
    old.deliver(frame(1))
    assertEquals(1, oldCount)
    assertEquals(0, freshCount)
    fresh.deliver(frame(1))
    assertEquals(0, freshCount)
    fresh.deliver(frame(2))
    assertEquals(1, freshCount)
  }

  @Test fun previewFailureDoesNotInterruptNativeDelivery() {
    val c = config(1)
    var nativeCount = 0
    c.relaySink = { nativeCount++ }
    c.previewSink = { throw IllegalStateException("synthetic preview failure") }
    repeat(10) { c.deliver(frame(1)) }
    assertEquals(10, nativeCount)
  }
}
