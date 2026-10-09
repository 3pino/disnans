package dev.disnans.notifier

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/** 端末の起動時に、有効なら常駐サービスを始める */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
    val prefs = Prefs(context)
    if (!prefs.enabled || prefs.serverUrl.isNullOrEmpty()) return
    try {
      NotifyService.start(context)
    } catch (ex: Exception) {
      Log.w("disnans", "起動時に常駐サービスを始められませんでした", ex)
    }
  }
}
