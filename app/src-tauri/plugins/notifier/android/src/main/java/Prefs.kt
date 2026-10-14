package dev.disnans.notifier

import android.content.Context

/** 常駐サービスの設定。サービスはアプリ（WebView）が起動していなくても動くので、ここに保存しておく */
internal class Prefs(context: Context) {
  private val prefs = context.getSharedPreferences("disnans.notifier", Context.MODE_PRIVATE)

  var serverUrl: String?
    get() = prefs.getString("server_url", null)
    set(v) = prefs.edit().putString("server_url", v).apply()

  var enabled: Boolean
    get() = prefs.getBoolean("enabled", false)
    set(v) = prefs.edit().putBoolean("enabled", v).apply()

  /**
   * 表示済みの通知のメッセージ ID（新しいものほど後ろ）。接続し直したときの再送で、同じ通知を二度出さないために使う。
   * サービスが作り直されても残るよう、設定に保存する。
   */
  var shownMessages: List<String>
    get() = prefs.getString("shown_messages", "").orEmpty().split('\n').filter { it.isNotEmpty() }
    set(v) = prefs.edit().putString("shown_messages", v.takeLast(SHOWN_LIMIT).joinToString("\n")).apply()

  private companion object {
    /** 覚えておく件数。サーバーの再送（直近10分・ユーザーごと50件）より多く持つ */
    const val SHOWN_LIMIT = 200
  }
}
