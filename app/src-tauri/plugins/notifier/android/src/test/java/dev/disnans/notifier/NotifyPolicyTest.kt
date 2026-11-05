package dev.disnans.notifier

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NotifyPolicyTest {
  private val a = NotifyPolicy.accountKey("http://srv:8080", "user-a")
  private val b = NotifyPolicy.accountKey("http://srv:8080", "user-b")
  private val other = NotifyPolicy.accountKey("http://other:8080", "user-a")

  // ---- 既読の位置（ULID の文字列の大小） ----

  @Test
  fun read_when_at_or_before_marker_and_unread_without_marker() {
    assertTrue(NotifyPolicy.isRead("01H0000000", "01H0000000"))
    assertTrue(NotifyPolicy.isRead("01H0000000", "01H0000001"))
    assertFalse(NotifyPolicy.isRead("01H0000002", "01H0000001"))
    assertFalse(NotifyPolicy.isRead("01H0000000", null))
  }

  @Test
  fun marker_only_moves_forward() {
    assertEquals("02", NotifyPolicy.maxMarker("01", "02"))
    assertEquals("02", NotifyPolicy.maxMarker("02", "01"))
    assertEquals("02", NotifyPolicy.maxMarker(null, "02"))
    assertEquals("01", NotifyPolicy.maxMarker("01", null))
    assertNull(NotifyPolicy.maxMarker(null, null))
  }

  // ---- 表示するか ----

  @Test
  fun hide_read_and_shown_messages_show_unread_unshown() {
    assertFalse(NotifyPolicy.shouldShow("01", "02", emptyList()))
    assertFalse(NotifyPolicy.shouldShow("03", "02", listOf("03")))
    assertTrue(NotifyPolicy.shouldShow("03", "02", listOf("01")))
    assertTrue(NotifyPolicy.shouldShow("03", null, emptyList()))
  }

  @Test
  fun sample_without_message_id_is_always_shown() {
    assertTrue(NotifyPolicy.shouldShow(null, "99", emptyList()))
  }

  // ---- タグ（アカウントとメッセージ ID を持つ） ----

  @Test
  fun tag_round_trips_account_and_message_id() {
    val tag = NotifyPolicy.messageTag(a, "01H0000001")
    assertEquals(a to "01H0000001", NotifyPolicy.parseTag(tag))
  }

  @Test
  fun foreign_tags_are_not_parsed() {
    assertNull(NotifyPolicy.parseTag(null))
    assertNull(NotifyPolicy.parseTag("call:1"))
    assertNull(NotifyPolicy.parseTag("msg:01H0000001"))
    assertNull(NotifyPolicy.parseTag(""))
  }

  // ---- 取り下げ（既読の位置まで・同じアカウントだけ） ----

  @Test
  fun cancel_only_same_account_at_or_before_marker() {
    val active = listOf(
      NotifyPolicy.ActiveNote(NotifyPolicy.messageTag(a, "01"), 1), // 既読・同じアカウント → 取り下げる
      NotifyPolicy.ActiveNote(NotifyPolicy.messageTag(a, "02"), 2), // 位置と同じ → 取り下げる
      NotifyPolicy.ActiveNote(NotifyPolicy.messageTag(a, "03"), 3), // 未読 → 残す
      NotifyPolicy.ActiveNote(NotifyPolicy.messageTag(b, "01"), 4), // 別のユーザー → 残す
      NotifyPolicy.ActiveNote(NotifyPolicy.messageTag(other, "01"), 5), // 別のサーバー → 残す
      NotifyPolicy.ActiveNote(null, 6), // サンプル・ほかの通知（タグなし） → 残す
      NotifyPolicy.ActiveNote("call:1", 7), // 通話の通知 → 残す
    )
    val targets = NotifyPolicy.cancelTargets(active, a, "02").map { it.id }
    assertEquals(listOf(1, 2), targets)
  }

  @Test
  fun nothing_cancelled_when_marker_is_older() {
    val active = listOf(NotifyPolicy.ActiveNote(NotifyPolicy.messageTag(a, "05"), 1))
    assertTrue(NotifyPolicy.cancelTargets(active, a, "04").isEmpty())
  }

  @Test
  fun unknown_account_is_never_cancelled() {
    val active = listOf(NotifyPolicy.ActiveNote(NotifyPolicy.messageTag(NotifyPolicy.UNKNOWN_ACCOUNT, "01"), 1))
    assertTrue(NotifyPolicy.cancelTargets(active, a, "09").isEmpty())
  }

  // ---- 既読の位置の保存（1 行 = アカウント・区切り・ID） ----

  @Test
  fun markers_round_trip_and_keep_only_the_newest_accounts() {
    val text = NotifyPolicy.encodeMarkers(linkedMapOf(a to "01", b to "02", other to "03"), 2)
    assertEquals(mapOf(b to "02", other to "03"), NotifyPolicy.decodeMarkers(text))
    assertEquals(mapOf(a to "01"), NotifyPolicy.decodeMarkers(NotifyPolicy.encodeMarkers(mapOf(a to "01"), 16)))
  }

  @Test
  fun markers_ignore_broken_lines() {
    assertTrue(NotifyPolicy.decodeMarkers("").isEmpty())
    assertTrue(NotifyPolicy.decodeMarkers("no-separator-here").isEmpty())
    assertEquals(mapOf(a to "01"), NotifyPolicy.decodeMarkers("junk\n$a${NotifyPolicy.SEP}01"))
  }
}
