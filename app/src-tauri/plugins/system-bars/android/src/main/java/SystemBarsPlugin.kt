package dev.disnans.systembars

import android.app.Activity
import androidx.core.view.WindowCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class StyleArgs {
  /** アプリのテーマがダークなら true（アイコンを明るくする） */
  var dark: Boolean = false
}

@TauriPlugin
class SystemBarsPlugin(private val activity: Activity) : Plugin(activity) {
  /** バーの色や edge-to-edge はそのままに、アイコンの明暗だけを変える */
  @Command
  fun setStyle(invoke: Invoke) {
    val args = invoke.parseArgs(StyleArgs::class.java)
    activity.runOnUiThread {
      try {
        val window = activity.window
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.isAppearanceLightStatusBars = !args.dark
        controller.isAppearanceLightNavigationBars = !args.dark
        invoke.resolve()
      } catch (ex: Exception) {
        invoke.reject(ex.message)
      }
    }
  }
}
