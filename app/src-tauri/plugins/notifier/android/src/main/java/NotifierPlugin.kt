package dev.disnans.notifier

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.webkit.WebView
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * notifier プラグインの入口。命令の名前と権限（build.rs・default.toml）はここに対応する。
 * 中身は機能ごとのクラス（共有・写真・振動・表示・通話・通知・診断）にあり、このクラスは配るだけ。
 */
@TauriPlugin(
  permissions = [
    Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications"),
    Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = "microphone"),
    // 最近の画像（写真アプリの一覧）。33 以上は READ_MEDIA_IMAGES、34 以上の部分的な許可は VISUAL_USER_SELECTED、
    // 32 以下は READ_EXTERNAL_STORAGE。文字列で書く（コンパイルの SDK の版に依らない）
    Permission(strings = ["android.permission.READ_MEDIA_IMAGES"], alias = "media"),
    Permission(strings = ["android.permission.READ_MEDIA_VISUAL_USER_SELECTED"], alias = "visual"),
    Permission(strings = ["android.permission.READ_EXTERNAL_STORAGE"], alias = "storage")
  ]
)
class NotifierPlugin(private val activity: Activity) : Plugin(activity) {
  private val prefs = Prefs(activity)

  private var webView: WebView? = null

  /** 機能が使う、このプラグインの接点（Plugin の保護された members は、ここでだけ包む） */
  private val bridge: NotifierBridge = object : NotifierBridge {
    override val activity: Activity get() = this@NotifierPlugin.activity
    override val prefs: Prefs get() = this@NotifierPlugin.prefs
    override val webView: WebView? get() = this@NotifierPlugin.webView
    override fun trigger(event: String, payload: JSObject) = this@NotifierPlugin.trigger(event, payload)
    override fun hasListener(event: String): Boolean = this@NotifierPlugin.hasListener(event)
    override fun permissionState(alias: String): PermissionState? = this@NotifierPlugin.getPermissionState(alias)
    override fun requestPermission(alias: String, invoke: Invoke, callback: String) =
      this@NotifierPlugin.requestPermissionForAlias(alias, invoke, callback)
    override fun requestPermissions(aliases: Array<String>, invoke: Invoke, callback: String) =
      this@NotifierPlugin.requestPermissionForAliases(aliases, invoke, callback)
  }

  private val share = NotifierShare(bridge)
  private val media = NotifierMedia(bridge)
  private val haptics = NotifierHaptics(bridge)
  private val display = NotifierDisplay(bridge)
  private val call = NotifierCall(bridge)
  private val notifications = NotifierNotify(bridge)
  private val diag = NotifierDiag(bridge)

  override fun load(webView: WebView) {
    this.webView = webView
    // プラグインの読み込みは、最初の前面（onResume）より後のことがあるので、ここでも受け口を付ける（二度目以降は何もしない）
    haptics.watch()
    haptics.applyToWebView()
    DiagLog.init(activity)
    DiagLog.i("[app] 起動しました（${DiagReport.appVersion(activity)}）")
    notifications.load()
    call.load()
    share.handle(activity.intent)
  }

  override fun onDestroy() {
    DiagLog.i("[app] アクティビティを閉じます（汎用通話=${CallService.running} ネイティブ通話=${NativeCallService.running}）")
    haptics.unwatch()
    call.close()
    webView = null
    share.shutdown()
  }

  /** アプリが起動している間に通知が開かれた、または共有された */
  override fun onNewIntent(intent: Intent) {
    if (share.handle(intent)) return
    notifications.onNewIntent(intent)
  }

  /**
   * 通話中は WebView を止めない（display が決める）。振動の受け口は前面のときだけ。
   * TauriActivity.onPause は、WryActivity の onPause（WebView.onPause()）のあとに、この処理を呼ぶ。
   */
  override fun onPause() {
    haptics.unwatch()
    display.onPause()
  }

  /** 裏から戻ったときの記録と、振動の受け口の付け直し */
  override fun onResume() {
    haptics.watch()
    haptics.applyToWebView()
    display.onResume()
  }

  // ---- Android の通話 ----

  @Command
  fun nativeCallStart(invoke: Invoke) = call.nativeStart(invoke)

  @PermissionCallback
  private fun nativeMicrophonePermission(invoke: Invoke) = call.microphonePermissionResult(invoke)

  @Command
  fun nativeCallStop(invoke: Invoke) = call.nativeStop(invoke)

  @Command
  fun nativeCallSnapshot(invoke: Invoke) = call.nativeSnapshot(invoke)

  @Command
  fun nativeCallControl(invoke: Invoke) = call.nativeControl(invoke)

  @Command
  fun nativeCallKick(invoke: Invoke) = call.nativeKick(invoke)

  @Command
  fun nativeCallEmit(invoke: Invoke) = call.nativeEmit(invoke)

  @Command
  fun takeCallActions(invoke: Invoke) = call.takeCallActions(invoke)

  @Command
  fun startCall(invoke: Invoke) = call.startCall(invoke)

  @Command
  fun stopCall(invoke: Invoke) = call.stopCall(invoke)

  @Command
  fun listAudioOutputs(invoke: Invoke) = call.listAudioOutputs(invoke)

  @Command
  fun setAudioOutput(invoke: Invoke) = call.setAudioOutput(invoke)

  // ---- 他のアプリからの共有 ----

  /** 起動時（コールドスタート）に共有されていた分を受け取る */
  @Command
  fun takeShared(invoke: Invoke) = share.take(invoke)

  // ---- 最近の画像・クリップボード ----

  @Command
  fun recentImages(invoke: Invoke) = media.recentImages(invoke)

  @Command
  fun requestRecentImagesPermission(invoke: Invoke) = media.requestRecentImagesPermission(invoke)

  @PermissionCallback
  private fun recentImagesPermissionCallback(invoke: Invoke) = media.recentPermissionResult(invoke)

  @Command
  fun readImage(invoke: Invoke) = media.readImage(invoke)

  @Command
  fun clipboardImage(invoke: Invoke) = media.clipboardImage(invoke)

  @Command
  fun clipboardPeek(invoke: Invoke) = media.clipboardPeek(invoke)

  @Command
  fun clipboardText(invoke: Invoke) = media.clipboardText(invoke)

  // ---- 表示・振動 ----

  @Command
  fun setOrientation(invoke: Invoke) = display.setOrientation(invoke)

  /** 通話の参加時に JS から呼ぶ（裏に回ったとき WebView を動かし続けるか） */
  @Command
  fun setKeepWebView(invoke: Invoke) = display.setKeepWebView(invoke)

  @Command
  fun vibrate(invoke: Invoke) = haptics.vibrate(invoke)

  @Command
  fun setHapticsEnabled(invoke: Invoke) = haptics.setEnabled(invoke)

  // ---- 診断 ----

  @Command
  fun diagLog(invoke: Invoke) = diag.log(invoke)

  @Command
  fun diagRead(invoke: Invoke) = diag.read(invoke)

  @Command
  fun diagClear(invoke: Invoke) = diag.clear(invoke)

  @Command
  fun diagShare(invoke: Invoke) = diag.share(invoke)

  // ---- 通知（常駐・許可・開いた先・電池） ----

  @Command
  fun takeLaunchTarget(invoke: Invoke) = notifications.takeLaunchTarget(invoke)

  /** 常駐サービスを有効にして始める */
  @Command
  fun start(invoke: Invoke) = notifications.start(invoke)

  @Command
  fun status(invoke: Invoke) = notifications.status(invoke)

  @Command
  fun requestPermission(invoke: Invoke) = notifications.requestPermission(invoke)

  @PermissionCallback
  private fun permissionCallback(invoke: Invoke) = notifications.permissionResult(invoke)

  @Command
  fun openBatterySettings(invoke: Invoke) = notifications.openBatterySettings(invoke)
}
