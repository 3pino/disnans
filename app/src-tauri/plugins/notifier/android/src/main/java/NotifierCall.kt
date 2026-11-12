package dev.disnans.notifier

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject

/**
 * Android の通話（ネイティブ）と、通話の前景サービス・音の出力先・通話の通知のボタン。
 * 通話の状態機械は NativeCallBridge（と NativeCall*）が持つ。ここは JS との受け渡しだけ。
 */
internal class NotifierCall(private val bridge: NotifierBridge) {
  private val activity get() = bridge.activity

  private val nativeCall by lazy {
    NativeCallBridge(
      activity,
      microphoneGranted = { ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED },
      requestMicrophone = { invoke -> bridge.requestPermission("microphone", invoke, MICROPHONE_CALLBACK) },
      deliver = { event -> if (bridge.webView != null && bridge.hasListener("call_native")) bridge.trigger("call_native", event) },
    )
  }

  /** 読み込み（プラグインの load から） */
  fun load() {
    nativeCall.load()
    CallService.actionSink = { id -> deliverCallAction(id) }
    CallService.failedSink = { deliverServiceFailed() }
  }

  /** 破棄（プラグインの onDestroy から） */
  fun close() {
    nativeCall.close()
    CallService.actionSink = null
    CallService.failedSink = null
  }

  /** マイクの許可の結果（@PermissionCallback から） */
  fun microphonePermissionResult(invoke: Invoke) = nativeCall.permissionResult(invoke)

  // Android の通話。開始の準備は許可を尋ねる前、停止の応答は wanted の永続的な解除のあと。
  fun nativeStart(invoke: Invoke) = nativeCall.start(invoke)
  fun nativeStop(invoke: Invoke) = nativeCall.stop(invoke)
  fun nativeSnapshot(invoke: Invoke) = nativeCall.snapshot(invoke)
  fun nativeControl(invoke: Invoke) = nativeCall.control(invoke)
  fun nativeKick(invoke: Invoke) = nativeCall.kick(invoke)
  fun nativeEmit(invoke: Invoke) = nativeCall.emit(invoke)

  /** 通話の通知のボタンを JS に届ける。リスナーがなければ false（サービスが溜める） */
  private fun deliverCallAction(id: String): Boolean {
    if (bridge.webView == null || !bridge.hasListener("call_action")) return false
    val o = JSObject()
    o.put("id", id)
    bridge.trigger("call_action", o)
    return true
  }

  /** 前景サービスを始められなかったことを、JS（リスナーがあれば）に知らせる */
  private fun deliverServiceFailed() {
    if (bridge.webView == null || !bridge.hasListener("call_service_failed")) return
    bridge.trigger("call_service_failed", JSObject())
  }

  /** サービスが溜めたボタンの押下を、まとめて渡す */
  fun takeCallActions(invoke: Invoke) {
    val ids = JSArray()
    while (true) ids.put(CallService.pendingActions.poll() ?: break)
    val ret = JSObject()
    ret.put("ids", ids)
    invoke.resolve(ret)
  }

  /** 通話用のフォアグラウンドサービス（microphone 型）を始める。マイクの許可を得たあと、前面にいるときに呼ぶ */
  fun startCall(invoke: Invoke) {
    val args = invoke.parseArgs(StartCallArgs::class.java)
    try {
      val actions = args.actions.map { CallButton(it.id, it.title, it.dismiss) }
      CallService.start(activity, args.title, args.text, args.microphone, actions)
      invoke.resolve()
    } catch (ex: Exception) {
      DiagLog.w("[call] 通話のサービスを始められませんでした", ex)
      invoke.reject(ex.message)
    }
  }

  fun stopCall(invoke: Invoke) {
    CallService.stop(activity)
    invoke.resolve()
  }

  /** 通話の音の出力先の一覧と、いまの出力先 */
  fun listAudioOutputs(invoke: Invoke) {
    try {
      requestBluetoothPermissionOnce()
      val arr = JSArray()
      for (o in CallAudio.list(activity)) {
        arr.put(JSObject().put("id", o.id).put("label", o.label).put("kind", o.kind))
      }
      val ret = JSObject()
      ret.put("outputs", arr)
      ret.put("current", CallAudio.current(activity))
      invoke.resolve(ret)
    } catch (ex: Exception) {
      invoke.reject(ex.message)
    }
  }

  fun setAudioOutput(invoke: Invoke) {
    val args = invoke.parseArgs(SetAudioOutputArgs::class.java)
    try {
      val ret = JSObject()
      val ok = CallAudio.set(activity, args.id)
      if (ok) nativeCall.outputSelected(args.id)
      ret.put("ok", ok)
      invoke.resolve(ret)
    } catch (ex: Exception) {
      invoke.reject(ex.message)
    }
  }

  private var askedBluetooth = false

  /** Android 12 以降、Bluetooth の出力先を見るには BLUETOOTH_CONNECT の許可がいる（最初の1回だけ尋ねる） */
  private fun requestBluetoothPermissionOnce() {
    if (askedBluetooth || Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
    askedBluetooth = true
    if (activity.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
      activity.requestPermissions(arrayOf(Manifest.permission.BLUETOOTH_CONNECT), 7201)
    }
  }

  companion object {
    /** @PermissionCallback の名前（プラグインの同名のメソッドに対応する） */
    const val MICROPHONE_CALLBACK = "nativeMicrophonePermission"
  }
}
