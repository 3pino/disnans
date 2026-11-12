package dev.disnans.app

import android.content.pm.ActivityInfo
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import dev.disnans.notifier.NotifierOrientation

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    applySavedOrientation()
  }

  /**
   * このデバイスで選んだ画面の向きを、WebView の読み込みの前に適用する（notifier プラグインの set_orientation が保存した値）。
   * 保存がなければ manifest のまま。保存の名前とキーは notifier プラグイン（NotifierOrientation）が持つ。
   */
  private fun applySavedOrientation() {
    val mode = NotifierOrientation.saved(this)
    if (mode == "portrait") {
      requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
    } else if (mode == "user") {
      requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_USER
    }
  }
}
