package dev.disnans.app

import android.content.pm.ActivityInfo
import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    applySavedOrientation()
  }

  /**
   * 端末で選んだ画面の向きを、WebView の読み込みの前に適用する（notifier プラグインの set_orientation が保存した値）。
   * 保存がなければ manifest のまま。キーは notifier プラグインの Prefs と同じ。
   */
  private fun applySavedOrientation() {
    val mode = getSharedPreferences("disnans.notifier", MODE_PRIVATE).getString("orientation", null)
    if (mode == "portrait") {
      requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
    } else if (mode == "user") {
      requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_USER
    }
  }
}
