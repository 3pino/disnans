package dev.disnans.notifier

import android.content.Context

/** 常駐サービスの設定。サービスはアプリ（WebView）が起動していなくても動くので、ここに保存しておく */
internal class Prefs(context: Context) {
  private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

  var serverUrl: String?
    get() = prefs.getString("server_url", null)
    set(v) = prefs.edit().putString("server_url", v).apply()

  /** 画面の向き（`portrait` / `user`）。未設定なら manifest のまま（MainActivity と同じキー） */
  var orientation: String?
    get() = prefs.getString(ORIENTATION_KEY, null)
    set(v) = prefs.edit().putString(ORIENTATION_KEY, v).apply()

  var enabled: Boolean
    get() = prefs.getBoolean("enabled", false)
    set(v) = prefs.edit().putBoolean("enabled", v).apply()

  /** 操作の振動（タッチの合図と WebView の標準の振動）をアプリの設定で止めるか。既定はオン */
  var hapticsEnabled: Boolean
    get() = prefs.getBoolean("haptics_enabled", true)
    set(v) = prefs.edit().putBoolean("haptics_enabled", v).apply()

  /**
   * アカウントごとの既読の位置（メッセージ ID）。通知の取り下げと、既読の通知を出さないことに使う。
   * 1 行 = アカウント・区切り・ID。アカウントは最近使った順に残す（多すぎないよう件数を絞る）。
   */
  fun lastRead(account: String): String? = readMarkers()[account]

  fun setLastRead(account: String, messageId: String) {
    val next = readMarkers().toMutableMap()
    next.remove(account)
    next[account] = messageId
    prefs.edit().putString(READ_MARKERS_KEY, NotifyPolicy.encodeMarkers(next, READ_ACCOUNTS_LIMIT)).apply()
  }

  private fun readMarkers(): Map<String, String> = NotifyPolicy.decodeMarkers(prefs.getString(READ_MARKERS_KEY, "").orEmpty())

  /**
   * 表示済みの通知のメッセージ ID（新しいものほど後ろ）。接続し直したときの再送で、同じ通知を二度出さないために使う。
   * サービスが作り直されても残るよう、設定に保存する。
   */
  var shownMessages: List<String>
    get() = prefs.getString("shown_messages", "").orEmpty().split('\n').filter { it.isNotEmpty() }
    set(v) = prefs.edit().putString("shown_messages", v.takeLast(SHOWN_LIMIT).joinToString("\n")).apply()

  companion object {
    /** SharedPreferences の名前と向きのキー。MainActivity（起動時に読む）と合わせる */
    const val PREFS_NAME = "disnans.notifier"
    const val ORIENTATION_KEY = "orientation"
    const val READ_MARKERS_KEY = "read_markers"
    const val READ_ACCOUNTS_LIMIT = 16

    /** 覚えておく件数。サーバーの再送（直近10分・ユーザーごと50件）より多く持つ */
    const val SHOWN_LIMIT = 200
  }
}

/**
 * WebView の読み込みより前に読む値（MainActivity が使う）。保存の名前とキーは [Prefs] と同じ。
 * 書くのは set_orientation だけ。
 */
object NotifierOrientation {
  /** "portrait"・"user"、未設定なら null（manifest のまま） */
  fun saved(context: Context): String? =
    context.getSharedPreferences(Prefs.PREFS_NAME, Context.MODE_PRIVATE).getString(Prefs.ORIENTATION_KEY, null)
}
