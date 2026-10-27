package dev.disnans.notifier

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.net.Uri
import android.os.Build
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.OpenableColumns
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
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
class LogCallArgs {
  lateinit var message: String
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
  var ms: Long = 12
}

@TauriPlugin(
  permissions = [
    Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications"),
    // 最近の画像（写真アプリの一覧）。33 以上は READ_MEDIA_IMAGES、34 以上の部分的な許可は VISUAL_USER_SELECTED、
    // 32 以下は READ_EXTERNAL_STORAGE。文字列で書く（コンパイルの SDK の版に依らない）
    Permission(strings = ["android.permission.READ_MEDIA_IMAGES"], alias = "media"),
    Permission(strings = ["android.permission.READ_MEDIA_VISUAL_USER_SELECTED"], alias = "visual"),
    Permission(strings = ["android.permission.READ_EXTERNAL_STORAGE"], alias = "storage")
  ]
)
class NotifierPlugin(private val activity: Activity) : Plugin(activity) {
  private val prefs = Prefs(activity)

  /** 通知から起動したときの行き先。JS の準備ができたら take_launch_target で受け取る */
  private var launchTarget: JSObject? = null

  private var webView: WebView? = null

  /** 通話中に裏へ回っても WebView を動かし続けるか（JS が通話の参加時に決める。既定は動かし続ける） */
  @Volatile
  private var keepWebView = true

  // ---- 他のアプリからの共有（ACTION_SEND / ACTION_SEND_MULTIPLE） ----

  private val shareLock = Any()
  /** 届け先（JS）がまだ受け取っていない共有。1件 = 1回の共有 */
  private val pendingShares = ArrayList<JSObject>()
  private val shareExecutor = Executors.newSingleThreadExecutor()

  override fun load(webView: WebView) {
    this.webView = webView
    DiagLog.init(activity)
    DiagLog.i("[app] 起動しました（${DiagReport.appVersion(activity)}）")
    NotifyService.createChannels(activity)
    launchTarget = targetOf(activity.intent)
    CallService.actionSink = { id -> deliverCallAction(id) }
    CallService.failedSink = { deliverServiceFailed() }
    handleShare(activity.intent)
  }

  override fun onDestroy() {
    DiagLog.i("[app] アクティビティを閉じます（通話中=${CallService.running}）")
    CallService.actionSink = null
    CallService.failedSink = null
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

  /** 前景サービスを始められなかったことを、JS（リスナーがあれば）に知らせる */
  private fun deliverServiceFailed() {
    if (webView == null || !hasListener("call_service_failed")) return
    trigger("call_service_failed", JSObject())
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

  // ---- 最近の画像（添付パネル）。権限は初回のパネルで求め、拒否なら空の一覧 ----

  private val mediaExecutor by lazy { Executors.newSingleThreadExecutor() }
  private val diagExecutor by lazy { Executors.newSingleThreadExecutor() }

  /** 写真の読み取りの状態。granted / limited（部分的な許可）/ denied */
  private fun photoPermission(): String {
    if (Build.VERSION.SDK_INT >= 33) {
      return when {
        getPermissionState("media") == PermissionState.GRANTED -> "granted"
        Build.VERSION.SDK_INT >= 34 && getPermissionState("visual") == PermissionState.GRANTED -> "limited"
        else -> "denied"
      }
    }
    return if (getPermissionState("storage") == PermissionState.GRANTED) "granted" else "denied"
  }

  private fun permissionObject(): JSObject {
    val ret = JSObject()
    ret.put("permission", photoPermission())
    return ret
  }

  /** 新しい写真の一覧。許可が無ければ空（ダイアログは出さない） */
  @Command
  fun recentImages(invoke: Invoke) {
    val args = invoke.parseArgs(RecentImagesArgs::class.java)
    val permission = photoPermission()
    Log.i(LOG_TAG, "[photos] recent_images permission=$permission sdk=${Build.VERSION.SDK_INT}")
    if (permission == "denied") {
      val ret = JSObject()
      ret.put("permission", permission)
      ret.put("images", JSArray())
      invoke.resolve(ret)
      return
    }
    val limit = args.limit.coerceIn(1, 60)
    mediaExecutor.execute {
      try {
        val arr = JSArray()
        for (item in RecentImages.list(activity, limit)) arr.put(item)
        val ret = JSObject()
        ret.put("permission", permission)
        ret.put("images", arr)
        activity.runOnUiThread { invoke.resolve(ret) }
      } catch (ex: Exception) {
        activity.runOnUiThread { invoke.reject(ex.message ?: "一覧を作れませんでした") }
      }
    }
  }

  /**
   * 許可を求める。結果の permission を返す。
   * 34 以上は READ_MEDIA_IMAGES と READ_MEDIA_VISUAL_USER_SELECTED を一緒に求める（片方だけだと部分的な許可の選択肢が出ない）。
   * 部分的な許可のときも、全部の許可へ上げられるように求め直す（システムが出すかは OS の判断）。
   */
  @Command
  fun requestRecentImagesPermission(invoke: Invoke) {
    val state = photoPermission()
    if (state == "granted") {
      invoke.resolve(permissionObject())
      return
    }
    val aliases = when {
      Build.VERSION.SDK_INT >= 34 -> arrayOf("media", "visual")
      Build.VERSION.SDK_INT >= 33 -> arrayOf("media")
      else -> arrayOf("storage")
    }
    Log.i(LOG_TAG, "[photos] request permission from=$state aliases=${aliases.joinToString()}")
    requestPermissionForAliases(aliases, invoke, "recentImagesPermissionCallback")
  }

  @PermissionCallback
  private fun recentImagesPermissionCallback(invoke: Invoke) {
    invoke.resolve(permissionObject())
  }

  /** 写真 1 枚の本体（base64）。id は recentImages の id（content URI） */
  @Command
  fun readImage(invoke: Invoke) {
    val args = invoke.parseArgs(ReadImageArgs::class.java)
    if (photoPermission() == "denied") {
      invoke.reject("写真へのアクセスが許可されていません", "denied")
      return
    }
    mediaExecutor.execute {
      try {
        val ret = RecentImages.read(activity, args.id)
        activity.runOnUiThread { invoke.resolve(ret) }
      } catch (ex: Exception) {
        activity.runOnUiThread { invoke.reject(ex.message ?: "読めませんでした") }
      }
    }
  }

  /**
   * クリップボードの画像（前面のときだけ読める）。画像が無ければ null（`resolve()` は JS の null）。
   * 画像の URI（MIME が画像と分かるもの）を、写真と同じ上限で読む。
   */
  @Command
  fun clipboardImage(invoke: Invoke) {
    val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
    val clip = clipboard?.primaryClip
    var found: Uri? = null
    var foundMime = ""
    if (clip != null) {
      for (i in 0 until clip.itemCount) {
        val candidate = clip.getItemAt(i).uri ?: continue
        val type = activity.contentResolver.getType(candidate) ?: continue
        if (type.startsWith("image/")) {
          found = candidate
          foundMime = type
          break
        }
      }
    }
    val uri = found
    if (uri == null) {
      invoke.resolve()
      return
    }
    val mime = foundMime
    mediaExecutor.execute {
      try {
        val ret = RecentImages.clipboard(activity, uri, mime)
        activity.runOnUiThread { invoke.resolve(ret) }
      } catch (ex: Exception) {
        activity.runOnUiThread { invoke.reject(ex.message ?: "読めませんでした") }
      }
    }
  }

  /**
   * クリップボードに何があるか（中身は読まない）。{ text, image } の真偽。
   * 説明（primaryClipDescription）だけを見るので、Android 12 以降の「貼り付けました」の通知は出ない
   */
  @Command
  fun clipboardPeek(invoke: Invoke) {
    val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
    val desc = clipboard?.primaryClipDescription
    var text = false
    var image = false
    if (desc != null) {
      for (i in 0 until desc.mimeTypeCount) {
        val type = desc.getMimeType(i)
        if (type.startsWith("text/")) text = true
        if (type.startsWith("image/")) image = true
      }
    }
    val ret = JSObject()
    ret.put("text", text)
    ret.put("image", image)
    invoke.resolve(ret)
  }

  /** クリップボードの文字（前面のときだけ読める）。文字が無ければ null（`resolve()` は JS の null） */
  @Command
  fun clipboardText(invoke: Invoke) {
    val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
    val clip = clipboard?.primaryClip
    if (clip == null || clip.itemCount == 0 || !clip.description.hasMimeType("text/*")) {
      invoke.resolve()
      return
    }
    val text = clip.getItemAt(0).coerceToText(activity)?.toString()
    if (text.isNullOrEmpty()) {
      invoke.resolve()
      return
    }
    val ret = JSObject()
    ret.put("text", text)
    invoke.resolve(ret)
  }

  companion object {
    private const val EXTRA_SHARE_HANDLED = "dev.disnans.notifier.SHARE_HANDLED"
    private const val SHARE_DIR = "disnans-share"
    private const val LOG_TAG = "disnans"
    private const val MAX_LOG_CHARS = 1000
    /** 1ファイルの上限。サーバーに上限はないが、JS が全体をメモリに読むのでデバイスの都合で決めている */
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
   * TauriActivity.onPause は、WryActivity の onPause（WebView.onPause()）のあとに、この処理を呼ぶ。
   * そのため、ここで動かし直すと WebView は動いたままになる（タイマーと音の経路を保つ）。
   * 実験用の逃げ道: localStorage 'disnans.keepWebViewResumed'='0' なら JS が keepWebView を false にする。
   */
  override fun onPause() {
    if (!CallService.running) {
      DiagLog.i("[app] 裏に回りました")
      return
    }
    if (!keepWebView) {
      DiagLog.i("[call] onPause: 無効のため WebView を止めたままにします")
      return
    }
    webView?.onResume()
    webView?.resumeTimers()
    DiagLog.i("[call] onPause: WebView を動かし続けます")
  }

  /** 裏から戻ったときの記録（WebView の状態は onPause のときに決めている） */
  override fun onResume() {
    if (!CallService.running) {
      DiagLog.i("[app] 前面に戻りました")
      return
    }
    DiagLog.i("[call] onResume: WebView は${if (keepWebView) "動き続けていました" else "止めたままでした"}")
  }

  /** 通話の参加時に JS から呼ぶ。false なら、裏に回ったとき WebView を止めたままにする（実験用） */
  @Command
  fun setKeepWebView(invoke: Invoke) {
    val args = invoke.parseArgs(SetKeepWebViewArgs::class.java)
    keepWebView = args.enabled
    if (args.enabled) raiseRendererPriority()
    invoke.resolve()
  }

  /**
   * レンダラー（WebView の描画・JS のプロセス）の優先度を、表示されていなくても下げないようにする。
   * 既定では裏に回った WebView の優先度が下がり、JS が止められやすい。Android 8 未満には無い設定。
   */
  private fun raiseRendererPriority() {
    val view = webView ?: return
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    activity.runOnUiThread {
      view.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
      DiagLog.i("[call] レンダラーの優先度を下げないようにしました")
    }
  }

  /**
   * 短い振動（ms）。WebView の navigator.vibrate は長押し中（user activation が無い）に拒否されるため、ネイティブで鳴らす。
   * 振動器が無い端末・許可が無い端末は何もしない（resolve）。
   */
  @Command
  fun vibrate(invoke: Invoke) {
    val args = invoke.parseArgs(VibrateArgs::class.java)
    try {
      val ms = args.ms.coerceIn(1L, 1000L)
      val vibrator: Vibrator? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        (activity.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
      } else {
        @Suppress("DEPRECATION")
        activity.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
      }
      if (vibrator != null && vibrator.hasVibrator()) {
        val effect = VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          // タッチ操作の振動として鳴らす。端末の「タッチ操作の振動」がオフなら、システムが鳴らさない（設定に従う）
          vibrator.vibrate(effect, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_TOUCH))
        } else {
          vibrator.vibrate(effect)
        }
      }
      invoke.resolve()
    } catch (ex: Exception) {
      invoke.reject(ex.message)
    }
  }

  /** 以前の版の JS が送る [call] のログ。いまは diag_log と同じく診断ログに残す */
  @Command
  fun logCall(invoke: Invoke) {
    val args = invoke.parseArgs(LogCallArgs::class.java)
    DiagLog.js("info", args.message.take(MAX_LOG_CHARS))
    invoke.resolve()
  }

  /** JS の console の行を診断ログに残す（リリース版では WebView の console が見えないため） */
  @Command
  fun diagLog(invoke: Invoke) {
    val args = invoke.parseArgs(DiagLogArgs::class.java)
    DiagLog.js(args.level, args.message.take(MAX_LOG_CHARS))
    invoke.resolve()
  }

  /** 診断ログの全文と、デバイスの状態（通知の許可・電池の制限・プロセスが終わった理由など） */
  @Command
  fun diagRead(invoke: Invoke) {
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

  @Command
  fun diagClear(invoke: Invoke) {
    DiagLog.clear()
    DiagLog.i("[app] 診断ログを消しました")
    invoke.resolve()
  }

  /** 書き出したログをテキストファイルにして、共有のシート（メール・チャットなど）を開く */
  @Command
  fun diagShare(invoke: Invoke) {
    val args = invoke.parseArgs(DiagShareArgs::class.java)
    try {
      DiagReport.share(activity, args.text, args.name)
      invoke.resolve()
    } catch (ex: Exception) {
      DiagLog.w("[app] ログを共有できませんでした", ex)
      invoke.reject(ex.message ?: "共有できませんでした")
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
      DiagLog.w("[call] 通話のサービスを始められませんでした", ex)
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

  /**
   * 画面の向き。`portrait` は自動回転が ON でも縦に固定、`user` はシステムの設定に従う。
   * 選んだ値は常駐サービスの設定と同じ SharedPreferences に残し、次の起動では MainActivity が WebView の読み込みの前に使う。
   */
  @Command
  fun setOrientation(invoke: Invoke) {
    val args = invoke.parseArgs(SetOrientationArgs::class.java)
    val (name, orientation) = when (args.mode) {
      "portrait" -> "portrait" to ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
      "user" -> "user" to ActivityInfo.SCREEN_ORIENTATION_USER
      else -> {
        invoke.reject("invalid_orientation")
        return
      }
    }
    prefs.orientation = name
    activity.runOnUiThread { activity.requestedOrientation = orientation }
    invoke.resolve()
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
      DiagLog.w("[notify] 常駐サービスを始められませんでした", ex)
      invoke.reject(ex.message)
    }
  }

  @Command
  fun stop(invoke: Invoke) {
    DiagLog.i("[notify] 常駐を無効にします")
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
