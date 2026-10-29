package dev.disnans.notifier

import android.app.Activity
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicLong

/** Activity の窓口だけを持つ。閉じても、参加済みの通話はサービスが持ち続ける。 */
internal class NativeCallBridge(
  private val activity: Activity,
  private val microphoneGranted: () -> Boolean,
  private val requestMicrophone: (Invoke) -> Unit,
  private val deliver: (JSObject) -> Unit,
) {
  private val context = activity.applicationContext
  private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "disnans-call-bridge").apply { isDaemon = true } }
  private val epoch = AtomicLong()
  @Volatile private var closed = false
  @Volatile private var pendingPermission: String? = null
  private var unlisten: (() -> Unit)? = null

  fun load() {
    val owner = epoch.incrementAndGet()
    unlisten?.invoke()
    unlisten = NativeCallHost.addListener { event ->
      // 音声はこの橋を通さない。符号化も、WebView のスレッドでは行わない。
      if (closed || (event is NativeCallEvent.Relay && event.relay.name == "audio")) return@addListener
      val encoded = NativeCallProtocol.encodeEvent(event)
      activity.runOnUiThread {
        if (!closed && epoch.get() == owner) deliver(JSObject(encoded))
      }
    }
    background { NativeCallHost.onUiLaunch(context) }
  }

  fun close() {
    closed = true
    epoch.incrementAndGet()
    unlisten?.invoke()
    unlisten = null
    // 許可待ちだけを取り消す。音声・接続を開始済みの通話は閉じない。
    val pending = pendingPermission
    pendingPermission = null
    background { if (pending != null) NativeCallHost.cancelPrepared(context, pending, "activity-closed") }
    // 受け付けた停止命令は最後まで実行する（shutdownNow は使わない）。
    worker.shutdown()
  }

  fun start(invoke: Invoke) = command(invoke) {
    val args = NativeCallProtocol.parseStartArgs(invoke.getRawArgs())
    if (closed) throw NativeCallProtocolException("ui_closed")
    if (!NativeCallHost.prepare(context, args.session, args)) throw NativeCallProtocolException("busy")
    pendingPermission = args.session
    if (closed) {
      pendingPermission = null
      NativeCallHost.cancelPrepared(context, args.session, "activity-closed")
      throw NativeCallProtocolException("ui_closed")
    }
    activity.runOnUiThread {
      if (closed || pendingPermission != args.session) {
        command(invoke) { resolveSnapshot(invoke) }
      } else if (microphoneGranted()) {
        permissionResult(invoke)
      } else {
        try {
          requestMicrophone(invoke)
        } catch (_: Exception) {
          command(invoke) {
            if (pendingPermission == args.session) pendingPermission = null
            NativeCallHost.cancelPrepared(context, args.session, "permission-failed")
            throw NativeCallProtocolException("permission_failed")
          }
        }
      }
    }
  }

  /** Tauri の許可の応答。元の引数を再び検証し、取り消された開始は決して実行しない。 */
  fun permissionResult(invoke: Invoke) = command(invoke) {
    val args = NativeCallProtocol.parseStartArgs(invoke.getRawArgs())
    if (closed || pendingPermission != args.session) {
      resolveSnapshot(invoke)
      return@command
    }
    if (!microphoneGranted()) {
      pendingPermission = null
      NativeCallHost.cancelPrepared(context, args.session, "permission-denied")
      throw NativeCallProtocolException("permission_denied")
    }
    pendingPermission = null
    if (!NativeCallHost.startPrepared(context, args.session)) {
      NativeCallHost.cancelPrepared(context, args.session, "start-failed")
      throw NativeCallProtocolException("start_failed")
    }
    resolveSnapshot(invoke)
  }

  fun stop(invoke: Invoke) = command(invoke) {
    val args = NativeCallProtocol.parseStopArgs(invoke.getRawArgs())
    if (pendingPermission == args.session) pendingPermission = null
    if (!NativeCallHost.stop(context, args.session, args.reason)) throw NativeCallProtocolException("stop_failed")
    invoke.resolve()
  }

  fun snapshot(invoke: Invoke) = command(invoke) { resolveSnapshot(invoke) }

  fun control(invoke: Invoke) = command(invoke) {
    val args = NativeCallProtocol.parseControlArgs(invoke.getRawArgs())
    requireOk(NativeCallHost.control(context, args.session, args.patch))
    invoke.resolve()
  }

  fun kick(invoke: Invoke) = command(invoke) {
    val (session, peer) = NativeCallProtocol.parseKickArgs(invoke.getRawArgs())
    requireOk(NativeCallHost.kick(context, session, peer))
    invoke.resolve()
  }

  fun emit(invoke: Invoke) = command(invoke) {
    val args = NativeCallProtocol.parseEmitArgs(invoke.getRawArgs())
    requireOk(NativeCallHost.emit(context, args.session, args.name, args.payload.toString()))
    invoke.resolve()
  }

  fun outputSelected(id: String) = background { NativeCallHost.noteOutputSelection(context, id) }

  private fun resolveSnapshot(invoke: Invoke) {
    val snapshot = NativeCallHost.snapshot(context) ?: throw NativeCallProtocolException("state_unknown")
    invoke.resolve(JSObject(NativeCallProtocol.encodeSnapshot(snapshot)))
  }

  private fun requireOk(result: Outcome) {
    if (!result.ok) throw NativeCallProtocolException(result.code ?: "native_failed")
  }

  private fun command(invoke: Invoke, task: () -> Unit) {
    try {
      worker.execute {
        try {
          task()
        } catch (e: NativeCallProtocolException) {
          reject(invoke, e.code)
        } catch (_: Exception) {
          // 例外には URL・ID・音声などが含まれうるため、内容は決して橋やログへ流さない。
          reject(invoke, "native_failed")
        }
      }
    } catch (_: RejectedExecutionException) {
      reject(invoke, "ui_closed")
    }
  }

  private fun background(task: () -> Unit) {
    try {
      worker.execute { try { task() } catch (_: Exception) { DiagLog.w("[native-call] 窓口の処理に失敗しました") } }
    } catch (_: RejectedExecutionException) {
      // 破棄後の画面からは、新しい作業を受け付けない。
    }
  }

  private fun reject(invoke: Invoke, rawCode: String) {
    val code = rawCode.takeIf { it.matches(Regex("[a-z_]{1,32}")) } ?: "native_failed"
    val message = when (code) {
      "permission_denied", "permission_failed" -> "マイクの許可を確認できませんでした"
      "stop_failed" -> "通話の停止を確認できませんでした"
      "state_unknown" -> "通話の状態を確認できませんでした"
      "busy" -> "別の通話を処理しています"
      else -> "通話の操作を完了できませんでした"
    }
    try { invoke.reject(message, code) } catch (_: Exception) { /* 画面がすでに無い */ }
  }
}
