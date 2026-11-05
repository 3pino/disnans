package dev.disnans.notifier

/**
 * 通知の判断のうち、Android の部品に依らない部分（JVM のテストで確かめる）。
 *
 * - アカウント: 接続先（サーバーの URL）と、そのサーバーでのユーザー ID の組。通知にも既読の位置にも付ける。
 *   別のアカウントの既読の位置では、ほかのアカウントの通知を取り下げない。
 * - 既読の位置: サーバーの既読（`message_id <= last_read_id` が既読。ULID の文字列の大小）と同じ判断。
 *   位置は進むだけ（戻さない）。
 */
internal object NotifyPolicy {
  /** 通知のタグの先頭。取り下げるときに、こちらの通知（メッセージ）だけを選ぶ */
  const val TAG_PREFIX = "msg"

  /** 区切り（URL にもユーザー ID にも現れない文字） */
  const val SEP = '\u001f'

  /** 接続先もユーザーも分からないときのアカウント（これで出した通知は、既読の位置では取り下げない） */
  val UNKNOWN_ACCOUNT: String = accountKey("", "")

  /** 取り下げの候補（通知のタグと ID。タグが無いものはこちらの通知ではない） */
  data class ActiveNote(val tag: String?, val id: Int)

  fun accountKey(server: String, userId: String): String = "$server$SEP$userId"

  fun messageTag(account: String, messageId: String): String = "$TAG_PREFIX$SEP$account$SEP$messageId"

  /** タグから、アカウントとメッセージ ID を取り出す。こちらの通知でなければ null */
  fun parseTag(tag: String?): Pair<String, String>? {
    if (tag == null) return null
    val p = tag.split(SEP)
    if (p.size != 4 || p[0] != TAG_PREFIX) return null
    return "${p[1]}$SEP${p[2]}" to p[3]
  }

  /** この位置まで既読か（位置と同じ ID も既読）。位置が無ければ未読 */
  fun isRead(messageId: String, lastRead: String?): Boolean = lastRead != null && messageId <= lastRead

  /** 既読の位置は進むだけ。新しいほうを返す */
  fun maxMarker(current: String?, incoming: String?): String? = when {
    incoming == null -> current
    current == null -> incoming
    incoming > current -> incoming
    else -> current
  }

  /** 出してよいか。既読・表示済みなら出さない */
  fun shouldShow(messageId: String?, lastRead: String?, shown: Collection<String>): Boolean {
    if (messageId == null) return true
    if (isRead(messageId, lastRead)) return false
    return messageId !in shown
  }

  /** 既読の位置まで読んだので取り下げる通知（同じアカウントで、位置以下のメッセージ） */
  fun cancelTargets(active: List<ActiveNote>, account: String, lastRead: String): List<ActiveNote> =
    active.filter { n ->
      val parsed = parseTag(n.tag) ?: return@filter false
      parsed.first == account && isRead(parsed.second, lastRead)
    }

  /** 既読の位置の保存の形（1 行 = アカウント・区切り・ID）。新しいものほど後ろ。件数は limit まで */
  fun encodeMarkers(markers: Map<String, String>, limit: Int): String =
    markers.entries.toList().takeLast(limit).joinToString("\n") { "${it.key}$SEP${it.value}" }

  fun decodeMarkers(text: String): Map<String, String> =
    text.lines().mapNotNull { line ->
      val i = line.lastIndexOf(SEP)
      if (i <= 0) null else line.substring(0, i) to line.substring(i + 1)
    }.toMap()
}
