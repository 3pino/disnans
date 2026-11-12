package dev.disnans.notifier

import app.tauri.annotation.InvokeArg

// NotifierPlugin の命令の引数。Tauri が JSON から組み立てる（クラス名と場所は、同じパッケージで変えない）

@InvokeArg
class StartArgs {
  lateinit var serverUrl: String
}

@InvokeArg
class CallActionArg {
  lateinit var id: String
  var title: String = ""
  var dismiss: Boolean = false
}

@InvokeArg
class StartCallArgs {
  var title: String = ""
  var text: String = ""
  var microphone: Boolean = true
  var actions: Array<CallActionArg> = arrayOf()
}

@InvokeArg
class RecentImagesArgs {
  var limit: Int = 20
}

@InvokeArg
class ReadImageArgs {
  lateinit var id: String
}

@InvokeArg
class SetAudioOutputArgs {
  lateinit var id: String
}

@InvokeArg
class SetOrientationArgs {
  lateinit var mode: String
}

@InvokeArg
class SetKeepWebViewArgs {
  var enabled: Boolean = true
}

@InvokeArg
class DiagLogArgs {
  var level: String = "info"
  lateinit var message: String
}

@InvokeArg
class DiagShareArgs {
  lateinit var text: String
  var name: String = "disnans-log.txt"
}

@InvokeArg
class VibrateArgs {
  var ms: Long = HapticsPolicy.MS_DEFAULT
  /** この呼び出しだけの指定。省けば有効（今の JS と同じ）。false なら鳴らさない（保存された設定とあわせて判断する） */
  var enabled: Boolean? = null
}

@InvokeArg
class SetHapticsArgs {
  /** 操作の振動のアプリの設定。省けば有効 */
  var enabled: Boolean? = null
}
