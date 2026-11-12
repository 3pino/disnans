package dev.disnans.notifier

import android.app.Activity
import android.webkit.WebView
import app.tauri.PermissionState
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject

/**
 * NotifierPlugin と、その機能（共有・写真・クリップボード・振動・表示・通話・通知・診断）のあいだの小さな接点。
 * プラグインだけが実装する（Plugin の trigger・許可などは保護されているので、プラグインの中で包む）。
 * 機能は、この接点と自分の状態だけを使う。
 */
internal interface NotifierBridge {
  val activity: Activity
  val prefs: Prefs
  /** 読み込まれた WebView。まだ無い・破棄されたあとは null */
  val webView: WebView?

  /** JS へ、名前つきの合図を送る */
  fun trigger(event: String, payload: JSObject)
  /** JS がその合図のリスナーを付けているか */
  fun hasListener(event: String): Boolean

  /** 許可の状態（null は未確定） */
  fun permissionState(alias: String): PermissionState?
  /** 許可を求める。結果は [callback]（プラグインの @PermissionCallback の名前）で返す */
  fun requestPermission(alias: String, invoke: Invoke, callback: String)
  fun requestPermissions(aliases: Array<String>, invoke: Invoke, callback: String)
}
