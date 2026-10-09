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
}
