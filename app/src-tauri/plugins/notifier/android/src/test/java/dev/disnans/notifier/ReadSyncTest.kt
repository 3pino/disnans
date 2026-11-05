package dev.disnans.notifier

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 既読の同期（接続の世代・アカウント・停止の判断と、WebSocket の 1 件の処理）を、偽物の口で確かめる */
class ReadSyncTest {
  private val base = "http://srv"
  private val a = NotifyPolicy.accountKey(base, "u-a")
  private val b = NotifyPolicy.accountKey(base, "u-b")

  /** 結果を自分で返せる取得（auto を入れると、取得した時点で返す） */
  private class FakeSource : ReadMarkerSource {
    val bases = mutableListOf<String>()
    var auto: ReadFetch? = null
    var cancels = 0
    private val pending = mutableListOf<(ReadFetch) -> Unit>()

    override fun fetch(base: String, callback: (ReadFetch) -> Unit): () -> Unit {
      bases += base
      auto?.let {
        callback(it)
        return { cancels++ }
      }
      pending += callback
      return { cancels++ }
    }

    /** まだ返していない取得のうち、いちばん古いものに結果を返す（返したら、取り消されても無視される） */
    fun deliver(result: ReadFetch) {
      val cb = pending.removeAt(0)
      cb(result)
    }

    fun pendingCount() = pending.size
  }

  private class Markers : MarkerStore {
    val values = HashMap<String, String>()
    var writes = 0
    override fun lastRead(account: String): String? = values[account]
    override fun setLastRead(account: String, messageId: String) {
      writes++
      values[account] = messageId
    }
  }

  private class Notes(initial: List<NotifyPolicy.ActiveNote> = emptyList()) : NoteStore {
    val list = initial.toMutableList()
    val cancelled = mutableListOf<NotifyPolicy.ActiveNote>()
    override fun active() = list.toList()
    override fun cancel(tag: String?, id: Int) {
      cancelled += NotifyPolicy.ActiveNote(tag, id)
      list.removeAll { it.tag == tag && it.id == id }
    }
  }

  private class Rig(
    val source: FakeSource = FakeSource(),
    val markers: Markers = Markers(),
    val notes: Notes = Notes(),
  ) {
    val owner = SyncOwner()
    val logs = mutableListOf<String>()
    val sync = ReadSync(owner, source, markers, notes, { it() }) { logs += it }
  }

  private fun note(account: String, id: String, notificationId: Int = id.hashCode()) =
    NotifyPolicy.ActiveNote(NotifyPolicy.messageTag(account, id), notificationId)

  private val callNote = NotifyPolicy.ActiveNote("call-tag", 99)

  // ---- hello → 既読の位置を読む → 取り下げ ----

  @Test
  fun hello_reads_the_marker_and_cancels_only_this_accounts_read_notes() {
    val rig = Rig(notes = Notes(listOf(note(a, "01"), note(a, "02"), note(a, "03"), note(b, "01"), callNote)))
    rig.source.auto = ReadFetch.Ok("02")
    val gen = rig.owner.beginConnection()
    rig.sync.onHello(gen, base, "u-a")
    assertEquals(listOf(base), rig.source.bases)
    assertEquals("02", rig.markers.values[a])
    assertEquals(listOf("01", "02"), rig.notes.cancelled.map { NotifyPolicy.parseTag(it.tag)?.second ?: "" }.filter { it.isNotEmpty() })
    // 未読の 03・別のアカウントの 01・通話の通知は残る
    assertEquals(setOf(note(a, "03"), note(b, "01"), callNote), rig.notes.list.toSet())
  }

  @Test
  fun a_read_update_on_this_connection_cancels_and_never_moves_the_marker_back() {
    val rig = Rig(notes = Notes(listOf(note(a, "05"))))
    rig.source.auto = ReadFetch.Ok("04")
    val gen = rig.owner.beginConnection()
    rig.sync.onHello(gen, base, "u-a")
    assertEquals("04", rig.markers.values[a])
    assertTrue(rig.notes.cancelled.isEmpty())

    rig.sync.onReadUpdated(gen, "06")
    assertEquals("06", rig.markers.values[a])
    assertEquals(listOf(note(a, "05")), rig.notes.cancelled)

    // 古い位置の更新では、戻さない（書き込みも起きない）
    val writes = rig.markers.writes
    rig.sync.onReadUpdated(gen, "01")
    assertEquals("06", rig.markers.values[a])
    assertEquals(writes, rig.markers.writes)
  }

  @Test
  fun a_read_update_before_hello_is_ignored() {
    val rig = Rig(notes = Notes(listOf(note(a, "01"))))
    val gen = rig.owner.beginConnection()
    rig.sync.onReadUpdated(gen, "09")
    assertTrue(rig.markers.values.isEmpty())
    assertEquals(1, rig.notes.list.size)
  }

  @Test
  fun a_hello_without_a_user_does_not_read_anything() {
    val rig = Rig()
    val gen = rig.owner.beginConnection()
    rig.sync.onHello(gen, base, "")
    assertTrue(rig.source.bases.isEmpty())
  }

  // ---- 古い結果・古い接続・停止 ----

  @Test
  fun a_result_from_an_old_connection_after_reconnect_cancels_nothing_and_stores_nothing() {
    val rig = Rig(notes = Notes(listOf(note(a, "01"))))
    val gen1 = rig.owner.beginConnection()
    rig.sync.onHello(gen1, base, "u-a")
    assertEquals(1, rig.source.pendingCount())

    // つなぎ直し（新しい世代）。前の取得は取り消され、遅れて届いても使わない
    val gen2 = rig.owner.beginConnection()
    assertEquals(1, rig.source.cancels)
    rig.source.deliver(ReadFetch.Ok("09"))
    assertNull(rig.markers.values[a])
    assertTrue(rig.notes.cancelled.isEmpty())
    assertTrue(rig.logs.any { it == "read-sync dropped reason=stale" })

    // 新しい接続の hello で読み直す
    rig.source.auto = ReadFetch.Ok("01")
    rig.sync.onHello(gen2, base, "u-a")
    assertEquals("01", rig.markers.values[a])
    assertEquals(listOf(note(a, "01")), rig.notes.cancelled)
  }

  @Test
  fun a_result_for_the_previous_user_is_dropped_when_another_user_says_hello_on_the_same_connection() {
    val rig = Rig(notes = Notes(listOf(note(a, "01"), note(b, "01"))))
    val gen = rig.owner.beginConnection()
    rig.sync.onHello(gen, base, "u-a")
    rig.sync.onHello(gen, base, "u-b")
    assertEquals(2, rig.source.pendingCount())
    // A の取得は取り消されている。遅れて A の位置が届いても、B のアカウントでは使わない
    rig.source.deliver(ReadFetch.Ok("05"))
    assertNull(rig.markers.values[a])
    rig.source.deliver(ReadFetch.Ok("01"))
    assertEquals("01", rig.markers.values[b])
    assertNull(rig.markers.values[a])
    assertEquals(listOf(note(b, "01")), rig.notes.cancelled)
  }

  @Test
  fun stop_cancels_the_read_in_flight_and_ignores_a_late_answer() {
    val rig = Rig(notes = Notes(listOf(note(a, "01"))))
    val gen = rig.owner.beginConnection()
    rig.sync.onHello(gen, base, "u-a")
    rig.owner.stop()
    assertEquals(1, rig.source.cancels)
    assertFalse(rig.owner.isCurrent(gen))
    rig.source.deliver(ReadFetch.Ok("01"))
    assertNull(rig.markers.values[a])
    assertTrue(rig.notes.cancelled.isEmpty())
    rig.sync.onReadUpdated(gen, "01")
    assertTrue(rig.notes.cancelled.isEmpty())
  }

  @Test
  fun a_failed_read_changes_nothing_and_logs_only_the_reason() {
    val rig = Rig(notes = Notes(listOf(note(a, "01"))))
    rig.source.auto = ReadFetch.Failed("http")
    val gen = rig.owner.beginConnection()
    rig.sync.onHello(gen, base, "u-a")
    assertTrue(rig.markers.values.isEmpty())
    assertEquals(1, rig.notes.list.size)
    assertEquals(listOf("read-sync failed reason=http"), rig.logs)
  }

  @Test
  fun the_log_holds_codes_and_counts_only() {
    val rig = Rig(notes = Notes(listOf(note(a, "0123ABCD"), note(a, "0123ABCE"))))
    rig.source.auto = ReadFetch.Ok("0123ABCF")
    val gen = rig.owner.beginConnection()
    rig.sync.onHello(gen, base, "u-a")
    val joined = rig.logs.joinToString("\n")
    assertTrue(joined, joined.contains("read-sync cancelled count=2"))
    for (secret in listOf("0123ABCD", "0123ABCF", "u-a", "srv", "http://")) assertFalse(joined, joined.contains(secret))
  }

  @Test
  fun a_reconnect_drops_the_account_until_the_next_hello() {
    val rig = Rig(notes = Notes(listOf(note(a, "01"))))
    val gen1 = rig.owner.beginConnection()
    rig.sync.onHello(gen1, base, "u-a")
    val gen2 = rig.owner.beginConnection()
    assertNull(rig.owner.accountFor(gen2))
    rig.sync.onReadUpdated(gen2, "09")
    assertTrue(rig.notes.cancelled.isEmpty())
  }

  @Test
  fun an_old_connection_cannot_read_a_marker_or_take_over_the_account() {
    val rig = Rig(notes = Notes(listOf(note(a, "01"))))
    val gen1 = rig.owner.beginConnection()
    val gen2 = rig.owner.beginConnection()
    rig.source.auto = ReadFetch.Ok("03")
    rig.sync.onHello(gen2, base, "u-a")
    assertEquals(listOf(note(a, "01")), rig.notes.cancelled)
    // 古い接続の hello と既読の更新は、新しい接続のアカウントで使わない
    rig.source.auto = ReadFetch.Ok("09")
    rig.sync.onHello(gen1, base, "u-b")
    assertEquals(1, rig.source.bases.size)
    rig.sync.onReadUpdated(gen1, "09")
    assertEquals("03", rig.markers.values[a])
    assertNull(rig.markers.values[b])
  }

  // ---- 再起動（持ち主は作り直し、既読の位置と通知は保存されたものを使う） ----

  @Test
  fun after_a_restart_the_saved_marker_and_the_still_posted_notes_are_used() {
    val markers = Markers().apply { values[a] = "02" }
    val posted = Notes(listOf(note(a, "01"), note(a, "03")))
    // 常駐サービスが作り直された（新しい持ち主）。通知は OS の側に残っている
    val rig = Rig(markers = markers, notes = posted)
    rig.source.auto = ReadFetch.Ok("02")
    val gen = rig.owner.beginConnection()
    rig.sync.onHello(gen, base, "u-a")
    assertEquals(listOf(note(a, "01")), rig.notes.cancelled)
    assertEquals(listOf(note(a, "03")), rig.notes.list)
    assertEquals("02", markers.values[a])
  }

  // ---- WebSocket の 1 件（hello・read.updated・notify の振り分け） ----

  @Test
  fun a_hello_message_reads_the_marker_and_cancels_the_read_notes() {
    val rig = Rig(notes = Notes(listOf(note(a, "01"), note(a, "02"), note(a, "03"))))
    rig.source.auto = ReadFetch.Ok("02")
    val gen = rig.owner.beginConnection()
    var notified = 0
    handleServerText("""{"type":"hello","me":{"id":"u-a","login_name":"x"},"users":[]}""", gen, base, rig.sync, rig.owner) { notified++ }
    assertEquals(1, rig.source.bases.size)
    assertEquals(listOf(note(a, "01"), note(a, "02")), rig.notes.cancelled)
    assertEquals(0, notified)
  }

  @Test
  fun read_updated_and_notify_messages_are_routed() {
    val rig = Rig(notes = Notes(listOf(note(a, "01"))))
    val gen = rig.owner.beginConnection()
    rig.sync.onHello(gen, base, "u-a") // 取得なし（pending のまま）
    rig.source.deliver(ReadFetch.Ok("00"))
    var notified = 0
    handleServerText("""{"type":"read.updated","marker":{"last_read_id":"01","unread_count":0}}""", gen, base, rig.sync, rig.owner) { notified++ }
    assertEquals(listOf(note(a, "01")), rig.notes.cancelled)
    handleServerText("""{"type":"notify","title":"t","body":"b","message_id":"05","sample":false,"replayed":false}""", gen, base, rig.sync, rig.owner) { notified++ }
    assertEquals(1, notified)
    assertEquals(1, rig.notes.cancelled.size)
  }

  @Test
  fun messages_from_an_old_connection_or_malformed_text_do_nothing() {
    val rig = Rig(notes = Notes(listOf(note(a, "01"))))
    val gen1 = rig.owner.beginConnection()
    rig.sync.onHello(gen1, base, "u-a")
    rig.source.deliver(ReadFetch.Ok("00"))
    val gen2 = rig.owner.beginConnection()
    var notified = 0
    handleServerText("""{"type":"read.updated","marker":{"last_read_id":"09"}}""", gen1, base, rig.sync, rig.owner) { notified++ }
    handleServerText("""{"type":"notify","title":"t","body":"b"}""", gen1, base, rig.sync, rig.owner) { notified++ }
    handleServerText("not json", gen2, base, rig.sync, rig.owner) { notified++ }
    handleServerText("""{"type":"something.else"}""", gen2, base, rig.sync, rig.owner) { notified++ }
    assertEquals(0, notified)
    assertTrue(rig.notes.cancelled.isEmpty())
  }

  @Test
  fun parse_server_message_reads_the_kinds_we_use() {
    assertEquals(ServerMessage.Hello("u-a"), parseServerMessage("""{"type":"hello","me":{"id":"u-a"}}"""))
    assertEquals(ServerMessage.Hello(""), parseServerMessage("""{"type":"hello"}"""))
    assertEquals(ServerMessage.ReadUpdated("07"), parseServerMessage("""{"type":"read.updated","marker":{"last_read_id":"07"}}"""))
    assertEquals(ServerMessage.ReadUpdated(null), parseServerMessage("""{"type":"read.updated","marker":{"last_read_id":5}}"""))
    assertEquals(ServerMessage.Notify, parseServerMessage("""{"type":"notify"}"""))
    assertEquals(ServerMessage.Other, parseServerMessage("[]"))
    assertEquals(ServerMessage.Other, parseServerMessage("garbage"))
  }

  @Test
  fun read_fetch_body_parsing_is_fixed_to_http_or_parse() {
    assertEquals(ReadFetch.Ok("01H"), readMarkerFrom(200, """[{"last_read_id":"01H","unread_count":2}]"""))
    assertEquals(ReadFetch.Failed("http"), readMarkerFrom(401, """[{"last_read_id":"01H"}]"""))
    assertEquals(ReadFetch.Failed("http"), readMarkerFrom(500, null))
    assertEquals(ReadFetch.Failed("parse"), readMarkerFrom(200, "[]"))
    assertEquals(ReadFetch.Failed("parse"), readMarkerFrom(200, "{}"))
    assertEquals(ReadFetch.Failed("parse"), readMarkerFrom(200, "nope"))
    assertEquals(ReadFetch.Failed("parse"), readMarkerFrom(200, """[{"last_read_id":""}]"""))
    assertEquals(ReadFetch.Failed("parse"), readMarkerFrom(200, null))
  }
}
