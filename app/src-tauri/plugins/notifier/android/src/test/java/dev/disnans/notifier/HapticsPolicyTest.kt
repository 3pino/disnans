package dev.disnans.notifier

import dev.disnans.notifier.HapticsPolicy.Decision
import dev.disnans.notifier.HapticsPolicy.Dnd
import dev.disnans.notifier.HapticsPolicy.Ringer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 操作の振動の判断（アプリの設定・サイレント・集中モード・既定・上下限）。システムのタッチ設定は読まない */
class HapticsPolicyTest {
  private val open = HapticsPolicy.Snapshot(appEnabled = true, ringer = Ringer.NORMAL, dnd = Dnd.ALL, hasVibrator = true)

  private fun skip(code: String) = Decision.Skip(code)

  @Test
  fun everything_allowed_vibrates() {
    assertEquals(Decision.Vibrate, HapticsPolicy.decide(open))
  }

  @Test
  fun ringer_vibrate_and_normal_both_allowed() {
    assertTrue(HapticsPolicy.allowed(true, Ringer.VIBRATE, Dnd.ALL))
    assertTrue(HapticsPolicy.allowed(true, Ringer.NORMAL, Dnd.ALL))
    assertEquals(Decision.Vibrate, HapticsPolicy.decide(open.copy(ringer = Ringer.VIBRATE)))
  }

  @Test
  fun silent_ringer_never_vibrates() {
    assertEquals(skip("ringer_silent"), HapticsPolicy.decide(open.copy(ringer = Ringer.SILENT)))
    assertFalse(HapticsPolicy.allowed(true, Ringer.SILENT, Dnd.ALL))
  }

  @Test
  fun do_not_disturb_modes_other_than_all_never_vibrate() {
    assertEquals(skip("dnd"), HapticsPolicy.decide(open.copy(dnd = Dnd.PRIORITY)))
    assertEquals(skip("dnd"), HapticsPolicy.decide(open.copy(dnd = Dnd.NONE)))
    assertEquals(skip("dnd"), HapticsPolicy.decide(open.copy(dnd = Dnd.ALARMS)))
    assertFalse(HapticsPolicy.allowed(true, Ringer.NORMAL, Dnd.PRIORITY))
  }

  @Test
  fun the_app_setting_off_never_vibrates_and_wins_over_everything() {
    assertEquals(skip("app_off"), HapticsPolicy.decide(open.copy(appEnabled = false)))
    assertEquals(skip("app_off"), HapticsPolicy.decide(open.copy(appEnabled = false, ringer = null, dnd = null)))
    assertFalse(HapticsPolicy.allowed(false, Ringer.NORMAL, Dnd.ALL))
  }

  @Test
  fun a_device_without_a_vibrator_never_vibrates() {
    assertEquals(skip("no_vibrator"), HapticsPolicy.decide(open.copy(hasVibrator = false)))
  }

  @Test
  fun unknown_or_unreadable_state_fails_closed() {
    assertEquals(skip("unknown_ringer"), HapticsPolicy.decide(open.copy(ringer = null)))
    assertEquals(skip("unknown_ringer"), HapticsPolicy.decide(open.copy(ringer = Ringer.UNKNOWN)))
    assertEquals(skip("unknown_dnd"), HapticsPolicy.decide(open.copy(dnd = null)))
    assertEquals(skip("unknown_dnd"), HapticsPolicy.decide(open.copy(dnd = Dnd.UNKNOWN)))
    assertFalse(HapticsPolicy.allowed(true, null, Dnd.ALL))
    assertFalse(HapticsPolicy.allowed(true, Ringer.NORMAL, null))
    assertFalse(HapticsPolicy.allowed(true, Ringer.UNKNOWN, Dnd.UNKNOWN))
  }

  @Test
  fun the_first_failing_check_gives_the_reason() {
    assertEquals(skip("app_off"), HapticsPolicy.decide(open.copy(appEnabled = false, ringer = Ringer.SILENT, dnd = Dnd.NONE)))
    assertEquals(skip("ringer_silent"), HapticsPolicy.decide(open.copy(ringer = Ringer.SILENT, dnd = Dnd.NONE)))
  }

  @Test
  fun the_explicit_app_flag_defaults_to_on_only_when_absent() {
    assertTrue(HapticsPolicy.appFlagFrom(null))
    assertTrue(HapticsPolicy.appFlagFrom(true))
    assertFalse(HapticsPolicy.appFlagFrom(false))
  }

  @Test
  fun ringer_mode_values_are_the_sdk_values() {
    assertEquals(Ringer.SILENT, HapticsPolicy.ringerOf(0))
    assertEquals(Ringer.VIBRATE, HapticsPolicy.ringerOf(1))
    assertEquals(Ringer.NORMAL, HapticsPolicy.ringerOf(2))
    assertEquals(Ringer.UNKNOWN, HapticsPolicy.ringerOf(3))
    assertEquals(Ringer.UNKNOWN, HapticsPolicy.ringerOf(-1))
    assertEquals(Ringer.UNKNOWN, HapticsPolicy.ringerOf(null))
  }

  @Test
  fun interruption_filter_values_are_the_sdk_values() {
    assertEquals(Dnd.ALL, HapticsPolicy.dndOf(1))
    assertEquals(Dnd.PRIORITY, HapticsPolicy.dndOf(2))
    assertEquals(Dnd.NONE, HapticsPolicy.dndOf(3))
    assertEquals(Dnd.ALARMS, HapticsPolicy.dndOf(4))
    assertEquals(Dnd.UNKNOWN, HapticsPolicy.dndOf(0))
    assertEquals(Dnd.UNKNOWN, HapticsPolicy.dndOf(5))
    assertEquals(Dnd.UNKNOWN, HapticsPolicy.dndOf(null))
  }

  @Test
  fun the_length_is_bounded_and_defaults_to_the_old_value() {
    assertEquals(12L, HapticsPolicy.MS_DEFAULT)
    assertEquals(1L, HapticsPolicy.clampMs(0))
    assertEquals(1L, HapticsPolicy.clampMs(-50))
    assertEquals(12L, HapticsPolicy.clampMs(12))
    assertEquals(1000L, HapticsPolicy.clampMs(1000))
    assertEquals(1000L, HapticsPolicy.clampMs(999_999))
  }
}
