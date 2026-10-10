package dev.disnans.notifier

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.os.PowerManager
import android.provider.Settings
import android.webkit.WebView
import androidx.core.app.NotificationManagerCompat
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

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
class SetAudioOutputArgs {
  lateinit var id: String
}

@TauriPlugin(
  permissions = [
    Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")
  ]
)
class NotifierPlugin(private val activity: Activity) : Plugin(activity) {
  private val prefs = Prefs(activity)

  /** 通知から起動したときの行き先。JS の準備ができたら take_launch_target で受け取る */
  private var launchTarget: JSObject? = null

  private var webView: WebView? = null

  // ---- 他のアプリからの共有（ACTION_SEND / ACTION_SEND_MULTIPLE） ----

  private val shareLock = Any()
  /** 届け先（JS）がまだ受け取っていない共有。1件 = 1回の共有 */
  private val pendingShares = ArrayList<JSObject>()
  private val shareExecutor = Executors.newSingleThreadExecutor()

  override fun load(webView: WebView) {
    this.webView = webView
    NotifyService.createChannels(activity)
    launchTarget = targetOf(activity.intent)
    CallService.actionSink = { id -> deliverCallAction(id) }
    handleShare(activity.intent)
  }

  override fun onDestroy() {
    CallService.actionSink = null
    shareExecutor.shutdown()
  }

  /** アプリが起動している間に通知が開かれた、または共有された */
  override fun onNewIntent(intent: Intent) {
    if (handleShare(intent)) return
    val target = targetOf(intent) ?: return
    if (hasListener("open")) trigger("open", target) else launchTarget = target
  }

  /** 通話の通知のボタンを JS に届ける。リスナーがなければ false（サービスが溜める） */
  private fun deliverCallAction(id: String): Boolean {
    if (webView == null || !hasListener("call_action")) return false
    val o = JSObject()
    o.put("id", id)
    trigger("call_action", o)
    return true
  }

  /** 届けられなかったボタンを受け取る（リスナーを付けた直後に呼ぶ） */
  @Command
  fun takeCallActions(invoke: Invoke) {
    val ids = JSArray()
    while (true) ids.put(CallService.pendingActions.poll() ?: break)
    val ret = JSObject()
    ret.put("ids", ids)
    invoke.resolve(ret)
  }

  /**
   * 共有の intent なら、content:// のファイルをアプリのキャッシュにコピーして JS に渡す（別スレッドで）。
   * 巨大な base64 を IPC に流さないよう、JS には名前・MIME・キャッシュ上のパスだけを渡し、中身は read_shared_file で読む。
   * 処理した intent は true。
   */
  private fun handleShare(intent: Intent?): Boolean {
    if (intent == null) return false
    val action = intent.action
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return false
    if (intent.getBooleanExtra(EXTRA_SHARE_HANDLED, false)) return true
    intent.putExtra(EXTRA_SHARE_HANDLED, true)

    val uris = LinkedHashSet<Uri>()
    @Suppress("DEPRECATION")
    if (action == Intent.ACTION_SEND) {
      (intent.getParcelableExtra<android.os.Parcelable>(Intent.EXTRA_STREAM) as? Uri)?.let { uris.add(it) }
    } else {
      intent.getParcelableArrayListExtra<android.os.Parcelable>(Intent.EXTRA_STREAM)?.forEach { (it as? Uri)?.let(uris::add) }
    }
    val clip = intent.clipData
    if (uris.isEmpty() && clip != null) {
      for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let { uris.add(it) }
    }
    val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
    val type = intent.type
    // 他のアプリの URI 権限は、この intent を受けている間だけ。コピーが終わるまで intent を保持する
    shareExecutor.execute {
      val item = JSObject()
      val files = JSArray()
      val errors = JSArray()
      cleanShareCache()
      val dir = File(File(activity.cacheDir, SHARE_DIR), UUID.randomUUID().toString())
      for (uri in uris) {
        try {
          files.put(copyShared(uri, type, dir))
        } catch (ex: Exception) {
          errors.put("${uri.lastPathSegment ?: "ファイル"}: ${ex.message ?: ex.javaClass.simpleName}")
        }
      }
      item.put("files", files)
      item.put("errors", errors)
      if (!text.isNullOrEmpty()) item.put("text", text)
      activity.runOnUiThread {
        synchronized(shareLock) { pendingShares.add(item) }
        flushShares()
      }
    }
    return true
  }

  /** content:// の1ファイルをキャッシュにコピーする。上限を超えたら例外 */
  private fun copyShared(uri: Uri, fallbackType: String?, dir: File): JSObject {
    // file:// などは、このアプリ自身の非公開ファイルを指せてしまうので受け付けない
    if (uri.scheme != "content") throw IllegalArgumentException("対応していない共有です")
    val resolver = activity.contentResolver
    var name: String? = null
    var size = -1L
    resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
      if (c.moveToFirst()) {
        val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        val si = c.getColumnIndex(OpenableColumns.SIZE)
        if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni)
        if (si >= 0 && !c.isNull(si)) size = c.getLong(si)
      }
    }
    if (size > MAX_SHARE_BYTES) throw IllegalArgumentException("大きすぎます（${MAX_SHARE_BYTES / 1024 / 1024} MB まで）")
    val mime = resolver.getType(uri) ?: fallbackType?.takeIf { !it.endsWith("/*") } ?: "application/octet-stream"
    val safe = (name ?: uri.lastPathSegment ?: "shared").substringAfterLast('/').replace('\\', '_').ifEmpty { "shared" }
    dir.mkdirs()
    val out = File(dir, safe)
    var total = 0L
    resolver.openInputStream(uri)?.use { input ->
      out.outputStream().use { o ->
        val buf = ByteArray(64 * 1024)
        while (true) {
          val n = input.read(buf)
          if (n < 0) break
          total += n
          if (total > MAX_SHARE_BYTES) {
            o.close()
            out.delete()
            throw IllegalArgumentException("大きすぎます（${MAX_SHARE_BYTES / 1024 / 1024} MB まで）")
          }
          o.write(buf, 0, n)
        }
      }
    } ?: throw IllegalStateException("開けませんでした")
    val f = JSObject()
    f.put("path", out.absolutePath)
    f.put("name", safe)
    f.put("mime", mime)
    f.put("size", total)
    return f
  }

  /** 古い共有のコピーを消す（JS が読み取って消すが、読まれなかった分の掃除） */
  private fun cleanShareCache() {
    val root = File(activity.cacheDir, SHARE_DIR)
    val limit = System.currentTimeMillis() - 24L * 60 * 60 * 1000
    root.listFiles()?.forEach { if (it.lastModified() < limit) it.deleteRecursively() }
  }

  /** リスナー（JS）がいれば、溜まった共有を全部届ける。いなければ take_shared を待つ */
  private fun flushShares() {
    if (!hasListener("share")) return
    val items = synchronized(shareLock) { ArrayList(pendingShares).also { pendingShares.clear() } }
    for (item in items) trigger("share", item)
  }

  /** 起動時（コールドスタート）に共有されていた分を受け取る */
  @Command
  fun takeShared(invoke: Invoke) {
    val arr = JSArray()
    synchronized(shareLock) {
      for (item in pendingShares) arr.put(item)
      pendingShares.clear()
    }
    val ret = JSObject()
    ret.put("shares", arr)
    invoke.resolve(ret)
  }

  companion object {
    private const val EXTRA_SHARE_HANDLED = "dev.disnans.notifier.SHARE_HANDLED"
    private const val SHARE_DIR = "disnans-share"
    /** 1ファイルの上限。サーバーに上限はないが、JS が全体をメモリに読むので端末の都合で決めている */
    private const val MAX_SHARE_BYTES = 200L * 1024 * 1024
  }

  private fun targetOf(intent: Intent?): JSObject? {
    if (intent?.getBooleanExtra(NotifyService.EXTRA_OPEN, false) != true) return null
    val target = JSObject()
    target.put("threadId", intent.getStringExtra(NotifyService.EXTRA_THREAD_ID))
    // 同じ intent で2回開かないようにする
    intent.removeExtra(NotifyService.EXTRA_OPEN)
    return target
  }

  @Command
  fun takeLaunchTarget(invoke: Invoke) {
    val ret = JSObject()
    ret.put("target", launchTarget)
    launchTarget = null
    invoke.resolve(ret)
  }

  /**
   * 通話中は、画面を消したり別のアプリに切り替えたりしても WebView を止めない。
   * WryActivity.onPause が WebView.onPause() を呼ぶので、その直後に動かし直す（タイマーと WebRTC を保つ）。
   */
  override fun onPause() {
    if (CallService.running) {
      webView?.onResume()
      webView?.resumeTimers()
    }
  }

  /** 通話用のフォアグラウンドサービス（microphone 型）を始める。マイクの許可を得たあと、前面にいるときに呼ぶ */
  @Command
  fun startCall(invoke: Invoke) {
    val args = invoke.parseArgs(StartCallArgs::class.java)
    try {
      val actions = args.actions.map { CallButton(it.id, it.title, it.dismiss) }
      CallService.start(activity, args.title, args.text, args.microphone, actions)
      invoke.resolve()
    } catch (ex: Exception) {
      invoke.reject(ex.message)
    }
  }

  /** 通話の音の出力先の一覧と、いまの出力先 */
  @Command
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

  @Command
  fun setAudioOutput(invoke: Invoke) {
    val args = invoke.parseArgs(SetAudioOutputArgs::class.java)
    try {
      val ret = JSObject()
      ret.put("ok", CallAudio.set(activity, args.id))
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
    if (activity.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
      activity.requestPermissions(arrayOf(Manifest.permission.BLUETOOTH_CONNECT), 7201)
    }
  }

  @Command
  fun stopCall(invoke: Invoke) {
    CallService.stop(activity)
    invoke.resolve()
  }

  /** 常駐サービスを有効にして始める（すでに動いていれば、新しい URL でつなぎ直す） */
  @Command
  fun start(invoke: Invoke) {
    val args = invoke.parseArgs(StartArgs::class.java)
    prefs.serverUrl = args.serverUrl
    prefs.enabled = true
    try {
      NotifyService.start(activity)
      invoke.resolve()
    } catch (ex: Exception) {
      invoke.reject(ex.message)
    }
  }

  @Command
  fun stop(invoke: Invoke) {
    prefs.enabled = false
    NotifyService.stop(activity)
    invoke.resolve()
  }

  @Command
  fun status(invoke: Invoke) {
    invoke.resolve(statusObject())
  }

  private fun statusObject(): JSObject {
    val ret = JSObject()
    ret.put("enabled", prefs.enabled)
    ret.put("running", NotifyService.running)
    ret.put("connected", NotifyService.connected)
    ret.put("permission", NotificationManagerCompat.from(activity).areNotificationsEnabled())
    val pm = activity.getSystemService(PowerManager::class.java)
    ret.put("batteryUnrestricted", pm.isIgnoringBatteryOptimizations(activity.packageName))
    return ret
  }

  /** 通知の許可を求める（Android 13 以降）。結果は status と同じ形で返す */
  @Command
  fun requestPermission(invoke: Invoke) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
      getPermissionState("notifications") == PermissionState.GRANTED
    ) {
      invoke.resolve(statusObject())
    } else {
      requestPermissionForAlias("notifications", invoke, "permissionCallback")
    }
  }

  @PermissionCallback
  private fun permissionCallback(invoke: Invoke) {
    invoke.resolve(statusObject())
  }

  /** 電池の最適化の対象から外すよう求める。省電力で接続が切られにくくなる */
  @SuppressLint("BatteryLife")
  @Command
  fun openBatterySettings(invoke: Invoke) {
    try {
      val intent = Intent(
        Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
        Uri.parse("package:${activity.packageName}")
      )
      activity.startActivity(intent)
      invoke.resolve()
    } catch (ex: Exception) {
      invoke.reject(ex.message)
    }
  }
}
