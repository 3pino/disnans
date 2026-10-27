package dev.disnans.notifier

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** デバイスの起動時に、有効なら常駐サービスを始める */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
    DiagLog.init(context)
    val prefs = Prefs(context)
    DiagLog.i("[notify] デバイスが起動しました（有効=${prefs.enabled}）")
    if (!prefs.enabled || prefs.serverUrl.isNullOrEmpty()) return
    try {
      NotifyService.start(context)
    } catch (ex: Exception) {
      // Android 12 以降は、起動時（バックグラウンド）から FGS を始められないことがある（機種や OS の版による）。
      // 黙って通知が来なくなるのを避けるため、アプリを開いてもらうよう知らせる
      DiagLog.w("[notify] 起動時に常駐サービスを始められませんでした", ex)
      NotifyService.askToOpen(context)
    }
  }
}
