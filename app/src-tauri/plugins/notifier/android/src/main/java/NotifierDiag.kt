package dev.disnans.notifier

import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import java.util.concurrent.Executors

/** 診断ログ（JS の console の行を含む）の読み書き・共有 */
internal class NotifierDiag(private val bridge: NotifierBridge) {
  private val activity get() = bridge.activity
  private val diagExecutor by lazy { Executors.newSingleThreadExecutor() }

  /** JS の console の行を診断ログに残す（リリース版では WebView の console が見えないため） */
  fun log(invoke: Invoke) {
    val args = invoke.parseArgs(DiagLogArgs::class.java)
    DiagLog.js(args.level, args.message.take(MAX_LOG_CHARS))
    invoke.resolve()
  }

  /** 診断ログの全文と、デバイスの状態（通知の許可・電池の制限・プロセスが終わった理由など） */
  fun read(invoke: Invoke) {
    diagExecutor.execute {
      try {
        val ret = JSObject()
        ret.put("device", DiagReport.device(activity))
        ret.put("log", DiagLog.read())
        activity.runOnUiThread { invoke.resolve(ret) }
      } catch (ex: Exception) {
        activity.runOnUiThread { invoke.reject(ex.message ?: "ログを読めませんでした") }
      }
    }
  }

  fun clear(invoke: Invoke) {
    DiagLog.clear()
    DiagLog.i("[app] 診断ログを消しました")
    invoke.resolve()
  }

  /** 書き出したログをテキストファイルにして、共有のシート（メール・チャットなど）を開く */
  fun share(invoke: Invoke) {
    val args = invoke.parseArgs(DiagShareArgs::class.java)
    try {
      DiagReport.share(activity, args.text, args.name)
      invoke.resolve()
    } catch (ex: Exception) {
      DiagLog.w("[app] ログを共有できませんでした", ex)
      invoke.reject(ex.message ?: "共有できませんでした")
    }
  }

  companion object {
    private const val MAX_LOG_CHARS = 1000
  }
}
