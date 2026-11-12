package dev.disnans.notifier

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import app.tauri.PermissionState
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject

/** 常駐サービス（通知を受け取る）・通知の許可・通知から開いたときの行き先・電池の制限 */
internal class NotifierNotify(private val bridge: NotifierBridge) {
  private val activity get() = bridge.activity
  private val prefs get() = bridge.prefs

  /** 通知から起動したときの行き先。JS の準備ができたら take_launch_target で受け取る */
  private var launchTarget: JSObject? = null

  /** 読み込み（プラグインの load から）。通知のチャンネルを作り、起動時の行き先を読む */
  fun load() {
    NotifyService.createChannels(activity)
    launchTarget = targetOf(activity.intent)
  }

  /** アプリが起動している間に通知が開かれた。JS がリスナーを付けていれば直接、なければ take_launch_target で受け取る */
  fun onNewIntent(intent: Intent) {
    val target = targetOf(intent) ?: return
    if (bridge.hasListener("open")) bridge.trigger("open", target) else launchTarget = target
  }

  private fun targetOf(intent: Intent?): JSObject? {
    if (intent?.getBooleanExtra(NotifyService.EXTRA_OPEN, false) != true) return null
    val target = JSObject()
    // 同じ intent で2回開かないようにする
    intent.removeExtra(NotifyService.EXTRA_OPEN)
    return target
  }

  fun takeLaunchTarget(invoke: Invoke) {
    val ret = JSObject()
    ret.put("target", launchTarget)
    launchTarget = null
    invoke.resolve(ret)
  }

  /** 常駐サービスを有効にして始める（すでに動いていれば、新しい URL でつなぎ直す） */
  fun start(invoke: Invoke) {
    val args = invoke.parseArgs(StartArgs::class.java)
    prefs.serverUrl = args.serverUrl
    prefs.enabled = true
    try {
      NotifyService.start(activity)
      invoke.resolve()
    } catch (ex: Exception) {
      DiagLog.w("[notify] 常駐サービスを始められませんでした", ex)
      invoke.reject(ex.message)
    }
  }

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
  fun requestPermission(invoke: Invoke) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
      bridge.permissionState("notifications") == PermissionState.GRANTED
    ) {
      invoke.resolve(statusObject())
    } else {
      bridge.requestPermission("notifications", invoke, PERMISSION_CALLBACK)
    }
  }

  /** 許可の結果（@PermissionCallback から） */
  fun permissionResult(invoke: Invoke) {
    invoke.resolve(statusObject())
  }

  /** 電池の最適化の対象から外すよう求める。省電力で接続が切られにくくなる */
  @SuppressLint("BatteryLife")
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

  companion object {
    /** @PermissionCallback の名前（プラグインの同名のメソッドに対応する） */
    const val PERMISSION_CALLBACK = "permissionCallback"
  }
}
