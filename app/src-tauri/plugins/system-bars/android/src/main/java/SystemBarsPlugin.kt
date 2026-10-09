package dev.disnans.systembars

import android.app.Activity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
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

@InvokeArg
class NavigationBarArgs {
  /** ナビゲーションバーを隠すなら true */
  var hidden: Boolean = false
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

  /** 最後に頼まれたナビゲーションバーの表示。アプリに戻ったときにかけ直す */
  private var navigationHidden = false

  /**
   * ナビゲーションバー（ジェスチャーのバーや3ボタン）を隠す・戻す。
   * 隠している間も、画面の下端からスワイプすると一時的に出る（しばらくすると自動で消える）。
   * 隠すとナビゲーションバーの分の WindowInsets が 0 になり、WebView の env(safe-area-inset-bottom) も 0 になる
   */
  @Command
  fun setNavigationBarHidden(invoke: Invoke) {
    val args = invoke.parseArgs(NavigationBarArgs::class.java)
    activity.runOnUiThread {
      try {
        navigationHidden = args.hidden
        applyNavigationBar()
        invoke.resolve()
      } catch (ex: Exception) {
        invoke.reject(ex.message)
      }
    }
  }

  // ほかのアプリから戻ったときなどに、システムがバーを出し直すことがあるので、かけ直す。
  // onResume(activity) は AppCompatActivity が要り、このプラグインからは見えないので古いほうを使う
  @Suppress("OVERRIDE_DEPRECATION", "DEPRECATION")
  override fun onResume() {
    if (!navigationHidden) return
    activity.runOnUiThread {
      try {
        applyNavigationBar()
      } catch (_: Exception) {
        // 戻せなくても使えるので無視する
      }
    }
  }

  private fun applyNavigationBar() {
    val window = activity.window
    val controller = WindowCompat.getInsetsController(window, window.decorView)
    if (navigationHidden) {
      controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      controller.hide(WindowInsetsCompat.Type.navigationBars())
    } else {
      controller.show(WindowInsetsCompat.Type.navigationBars())
    }
  }
}
