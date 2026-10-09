package dev.disnans.notifier

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.webkit.WebView
import androidx.core.app.NotificationManagerCompat
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class StartArgs {
  lateinit var serverUrl: String
}

@TauriPlugin(
  permissions = [
    Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")
  ]
)
class NotifierPlugin(private val activity: Activity) : Plugin(activity) {
  private val prefs = Prefs(activity)

  /** 通知から起動したときの行き先。JS の準備ができたら take_launch_target で受け取る */
  private var launchTarget: JSObject? = null

  override fun load(webView: WebView) {
    NotifyService.createChannels(activity)
    launchTarget = targetOf(activity.intent)
  }

  /** アプリが起動している間に通知が開かれた */
  override fun onNewIntent(intent: Intent) {
    val target = targetOf(intent) ?: return
    if (hasListener("open")) trigger("open", target) else launchTarget = target
  }

  private fun targetOf(intent: Intent?): JSObject? {
    if (intent?.getBooleanExtra(NotifyService.EXTRA_OPEN, false) != true) return null
    val target = JSObject()
    target.put("threadId", intent.getStringExtra(NotifyService.EXTRA_THREAD_ID))
    // 同じ intent で2回開かないようにする
    intent.removeExtra(NotifyService.EXTRA_OPEN)
    return target
  }

  @Command
  fun takeLaunchTarget(invoke: Invoke) {
    val ret = JSObject()
    ret.put("target", launchTarget)
    launchTarget = null
    invoke.resolve(ret)
  }

  /** 常駐サービスを有効にして始める（すでに動いていれば、新しい URL でつなぎ直す） */
  @Command
  fun start(invoke: Invoke) {
    val args = invoke.parseArgs(StartArgs::class.java)
    prefs.serverUrl = args.serverUrl
    prefs.enabled = true
    try {
      NotifyService.start(activity)
      invoke.resolve()
    } catch (ex: Exception) {
      invoke.reject(ex.message)
    }
  }

  @Command
  fun stop(invoke: Invoke) {
    prefs.enabled = false
    NotifyService.stop(activity)
    invoke.resolve()
  }

  @Command
  fun status(invoke: Invoke) {
    invoke.resolve(statusObject())
  }

  private fun statusObject(): JSObject {
    val ret = JSObject()
    ret.put("enabled", prefs.enabled)
    ret.put("running", NotifyService.running)
    ret.put("connected", NotifyService.connected)
    ret.put("permission", NotificationManagerCompat.from(activity).areNotificationsEnabled())
    val pm = activity.getSystemService(PowerManager::class.java)
    ret.put("batteryUnrestricted", pm.isIgnoringBatteryOptimizations(activity.packageName))
    return ret
  }

  /** 通知の許可を求める（Android 13 以降）。結果は status と同じ形で返す */
  @Command
  fun requestPermission(invoke: Invoke) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
      getPermissionState("notifications") == PermissionState.GRANTED
    ) {
      invoke.resolve(statusObject())
    } else {
      requestPermissionForAlias("notifications", invoke, "permissionCallback")
    }
  }

  @PermissionCallback
  private fun permissionCallback(invoke: Invoke) {
    invoke.resolve(statusObject())
  }

  /** 電池の最適化の対象から外すよう求める。省電力で接続が切られにくくなる */
  @SuppressLint("BatteryLife")
  @Command
  fun openBatterySettings(invoke: Invoke) {
    try {
      val intent = Intent(
        Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
        Uri.parse("package:${activity.packageName}")
      )
      activity.startActivity(intent)
      invoke.resolve()
    } catch (ex: Exception) {
      invoke.reject(ex.message)
    }
  }
}
