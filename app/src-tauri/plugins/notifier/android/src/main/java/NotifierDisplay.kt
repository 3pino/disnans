package dev.disnans.notifier

import android.content.pm.ActivityInfo
import android.os.Build
import android.webkit.WebView
import app.tauri.plugin.Invoke

/**
 * 画面の向き（起動時に MainActivity が使う値と同じ保存）と、通話中に WebView を動かし続けるかどうか。
 */
internal class NotifierDisplay(private val bridge: NotifierBridge) {
  private val activity get() = bridge.activity

  /** 通話中に裏へ回っても WebView を動かし続けるか（JS が通話の参加時に決める。既定は動かし続ける） */
  @Volatile
  private var keepWebView = true

  /**
   * 画面の向き。`portrait` は自動回転が ON でも縦に固定、`user` はシステムの設定に従う。
   * 選んだ値は常駐サービスの設定と同じ SharedPreferences に残し、次の起動では MainActivity が WebView の読み込みの前に使う。
   */
  fun setOrientation(invoke: Invoke) {
    val args = invoke.parseArgs(SetOrientationArgs::class.java)
    val (name, orientation) = when (args.mode) {
      "portrait" -> "portrait" to ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
      "user" -> "user" to ActivityInfo.SCREEN_ORIENTATION_USER
      else -> {
        invoke.reject("invalid_orientation")
        return
      }
    }
    bridge.prefs.orientation = name
    activity.runOnUiThread { activity.requestedOrientation = orientation }
    invoke.resolve()
  }

  /** 通話の参加時に JS から呼ぶ。false なら、裏に回ったとき WebView を止めたままにする（実験用） */
  fun setKeepWebView(invoke: Invoke) {
    val args = invoke.parseArgs(SetKeepWebViewArgs::class.java)
    keepWebView = args.enabled
    if (args.enabled) raiseRendererPriority()
    invoke.resolve()
  }

  /**
   * レンダラー（WebView の描画・JS のプロセス）の優先度を、表示されていなくても下げないようにする。
   * 既定では裏に回った WebView の優先度が下がり、JS が止められやすい。Android 8 未満には無い設定。
   */
  private fun raiseRendererPriority() {
    val view: WebView = bridge.webView ?: return
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    activity.runOnUiThread {
      view.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
      DiagLog.i("[call] レンダラーの優先度を下げないようにしました")
    }
  }

  /**
   * 通話中は、画面を消したり別のアプリに切り替えたりしても WebView を止めない。
   * TauriActivity.onPause は、WryActivity の onPause（WebView.onPause()）のあとに、この処理を呼ぶ。
   * そのため、ここで動かし直すと WebView は動いたままになる（タイマーと音の経路を保つ）。
   * 実験用の逃げ道: localStorage 'disnans.keepWebViewResumed'='0' なら JS が keepWebView を false にする。
   */
  fun onPause() {
    if (!CallService.running) {
      DiagLog.i("[app] 裏に回りました")
      return
    }
    if (!keepWebView) {
      DiagLog.i("[call] onPause: 無効のため WebView を止めたままにします")
      return
    }
    bridge.webView?.onResume()
    bridge.webView?.resumeTimers()
    DiagLog.i("[call] onPause: WebView を動かし続けます")
  }

  /** 裏から戻ったときの記録（WebView の状態は onPause のときに決めている） */
  fun onResume() {
    if (!CallService.running) {
      DiagLog.i("[app] 前面に戻りました")
      return
    }
    DiagLog.i("[call] onResume: WebView は${if (keepWebView) "動き続けていました" else "止めたままでした"}")
  }
}
