package dev.disnans.notifier

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 前景サービスの純粋な判断（API の段ごとに前景の種類を付けるかどうか）。Android の呼び出しは含まない */
class ForegroundSupportTest {
  private val micType = 128
  private val remoteType = 512

  @Test
  fun type_is_passed_from_the_minimum_api_level_on() {
    assertEquals(micType, ForegroundSupport.typeFor(sdk = 30, minSdk = 30, type = micType))
    assertEquals(micType, ForegroundSupport.typeFor(sdk = 34, minSdk = 30, type = micType))
  }

  @Test
  fun below_the_minimum_no_type_is_used() {
    assertNull(ForegroundSupport.typeFor(sdk = 29, minSdk = 30, type = micType))
    assertNull(ForegroundSupport.typeFor(sdk = 33, minSdk = 34, type = remoteType))
  }

  @Test
  fun the_three_services_thresholds_are_29_30_and_34() {
    // 通話（CallService）は 29 から、ネイティブの通話は 30 から、通知（NotifyService）は 34 から種類を付ける
    assertNull(ForegroundSupport.typeFor(28, 29, remoteType))
    assertEquals(remoteType, ForegroundSupport.typeFor(29, 29, remoteType))
    assertNull(ForegroundSupport.typeFor(29, 30, micType))
    assertEquals(micType, ForegroundSupport.typeFor(30, 30, micType))
    assertNull(ForegroundSupport.typeFor(33, 34, remoteType))
    assertEquals(remoteType, ForegroundSupport.typeFor(34, 34, remoteType))
  }

  @Test
  fun the_call_channel_id_is_the_one_both_call_services_use() {
    assertEquals("call", ForegroundSupport.CALL_CHANNEL)
  }
}
