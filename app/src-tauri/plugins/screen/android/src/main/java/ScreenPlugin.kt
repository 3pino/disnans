package dev.disnans.screen

import android.app.Activity
import android.app.PictureInPictureParams
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.util.Base64
import android.view.PixelCopy
import java.io.ByteArrayOutputStream
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.util.Rational
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import androidx.core.app.OnPictureInPictureModeChangedProvider
import androidx.core.app.PictureInPictureModeChangedInfo
import androidx.core.util.Consumer
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class StartCaptureArgs {
  /** 画像の長辺の最大（ピクセル） */
  var maxEdge: Int = 1280
  /** 0〜1 */
  var quality: Double = 0.6
  var fps: Int = 5
  /** jpeg / webp */
  var format: String = "jpeg"
  /** full / c256 / gray */
  var color: String = "full"
  /** 前のフレームとの差（0〜255 の平均）がこれ以下なら送らない */
  var diffThreshold: Double = 1.5
  var keepaliveMs: Long = 5000
  /** JS が付ける画面の番号（イベントと停止をこの番号で絞る）。0 は無し */
  var captureId: Long = 0
}

@InvokeArg
class UpdateCaptureArgs {
  var quality: Double? = null
  var scale: Double? = null
}

@InvokeArg
class SnapshotArgs {
  /** 画像の長辺の最大（ピクセル） */
  var maxEdge: Int = 1920
  /** JPEG の品質（0〜1） */
  var quality: Double = 0.85
}

@InvokeArg
class EnterPipArgs {
  var width: Int = 16
  var height: Int = 9
}

/**
 * 画面のキャプチャ（MediaProjection。フォアグラウンドサービス CaptureService の中で動く）と、ピクチャーインピクチャー。
 * フレームは `capture_frame`、終わったことは `capture_end`、小窓の出入りは `pip_change` のイベントで JS に渡す。
 */
/** 静止画を待つ時間の上限 */
private const val SNAPSHOT_TIMEOUT_MS = 8000L

@TauriPlugin
class ScreenPlugin(private val activity: Activity) : Plugin(activity) {
  private var webView: WebView? = null


  /** いま小窓になっている */
  @Volatile private var inPip = false

  /** 撮りの要求（許可のダイアログの結果を待つあいだ）。すべてのモードで、この 1 件だけ */
  private val gate = CaptureGate<Invoke, CaptureRequest>()
  /** いま中継している画面（無ければ null）と、その番号 */
  @Volatile private var relay: ShareRelayHost? = null
  @Volatile private var relayCaptureId = 0L
  /** 最後に終わった画面の番号（同じ終わりを二度知らせないため） */
  @Volatile private var endedCaptureId = 0L
  /** Activity が前面にいる（onResume で真、onPause で偽） */
  @Volatile private var resumed = true
  /** 見せられなかった最新の 1 枚（前面に戻ったとき、一度だけ見せる） */
  @Volatile private var heldPreview: CapturedFrame? = null

  private class CaptureRequest(val args: StartCaptureArgs, val relay: RelayRequest?)
  private class RelayRequest(val binding: RelayBinding, val config: RelayConfig)

  private val pipListener = Consumer<PictureInPictureModeChangedInfo> { info ->
    inPip = info.isInPictureInPictureMode
    val o = JSObject()
    o.put("active", inPip)
    trigger("pip_change", o)
  }

  override fun load(webView: WebView) {
    this.webView = webView
    CaptureService.frameSink = { frame -> deliverFrame(frame) }
    CaptureService.endSink = { id, reason -> onCaptureEnded(id, reason) }
    (activity as? OnPictureInPictureModeChangedProvider)?.addOnPictureInPictureModeChangedListener(pipListener)
  }

  override fun onDestroy() {
    webView = null
    CaptureService.frameSink = null
    CaptureService.endSink = null
    gate.pendingId()?.let { CaptureService.cancelReservation(it) }
    (activity as? OnPictureInPictureModeChangedProvider)?.removeOnPictureInPictureModeChangedListener(pipListener)
    // Activity が消えたら、待ち・中継（送り手）を終えてから画面を止める
    gate.clear()
    stopRelay("activity_destroyed")
    heldPreview = null
    CaptureService.stop(activity)
  }

  /**
   * 裏に回ると Activity が onPause になり、WebView の休止によって共有の送信や生存通知が途切れ得る。
   * 小窓か、JS が送信する従来の共有のあいだだけ動かし直す。ネイティブ中継はページの動作に依存しない。
   * 通話のネイティブ化で、通話中の WebView を保つ処理（NotifierPlugin.onPause）は CallService が動くときだけなので、ここで自前に保つ。
   * TauriActivity.onPause は WebView.onPause() のあとに、この処理を呼ぶ。
   */
  override fun onPause() {
    resumed = false
    if (!RelayPolicy.keepWebViewActive(inPip, CaptureService.running, relay != null)) return
    // 送信のレンダラーを、表示されていなくても下げない（API 26 以上）
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      webView?.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
    }
    webView?.onResume()
    webView?.resumeTimers()
  }

  /** 前面に戻った。見せられなかった最新の 1 枚を、一度だけ見せる */
  override fun onResume() {
    resumed = true
    val held = heldPreview
    heldPreview = null
    if (held != null) deliverFrame(held)
  }

  // ---- 画面のキャプチャ ----

  /** JS の callRelay を、型まで厳しく検査する（無い・在るの区別。在るのに形が違えば拒否） */
  private fun parseRelay(invoke: Invoke): RelayParse {
    val args = invoke.getArgs()
    val present = args.has("callRelay")
    return RelayConfig.fromRaw(present, if (present) jsonToKotlin(args.get("callRelay")) else null)
  }

  /** JSON の値を、検査しやすい Kotlin の値へ（オブジェクトは Map、配列は List、null は null） */
  private fun jsonToKotlin(v: Any?): Any? = when (v) {
    JSONObject.NULL -> null
    is JSONObject -> LinkedHashMap<String, Any?>().also { m -> v.keys().asSequence().forEach { k -> m[k] = jsonToKotlin(v.opt(k)) } }
    is JSONArray -> (0 until v.length()).map { jsonToKotlin(v.opt(it)) }
    else -> v
  }

  /** OS の確認のダイアログ（画面の録画の許可）を出し、許可されたらサービスで撮り始める */
  @Command
  fun startCapture(invoke: Invoke) {
    val args = invoke.parseArgs(StartCaptureArgs::class.java)
    try {
      // 許可を待っている要求が、もう一つあるなら受け付けない（結果を取り違えないため）
      if (gate.isBusy()) {
        invoke.reject("別の画面の共有の確認を待っています", "busy")
        return
      }
      var relayReq: RelayRequest? = null
      when (val parsed = parseRelay(invoke)) {
        is RelayParse.Absent -> {}
        is RelayParse.Err -> {
          invoke.reject("画面の中継の要求が正しくありません", parsed.code)
          return
        }
        is RelayParse.Ok -> {
          // 中継は、通話に参加しているときだけ。番号も、中継のときは必ず要る
          if (args.captureId == 0L) {
            invoke.reject("画面の中継には、画面の番号が要ります", "bad_capture_id")
            return
          }
          val read = ShareRelayHost.readBinding(activity)
          if (read is BindingRead.Unavailable) {
            invoke.reject("通話の状態を読めなかったため、画面を中継できません", "unavailable")
            return
          }
          val b = RelayPolicy.callOf(read)
          if (b == null || !RelayPolicy.startable(b)) {
            invoke.reject("通話に参加していないため、画面を中継できません", "not_joined")
            return
          }
          relayReq = RelayRequest(b, parsed.config)
        }
      }
      if (!gate.begin(invoke, args.captureId, CaptureRequest(args, relayReq))) {
        invoke.reject("別の画面の共有の確認を待っています", "busy")
        return
      }
      // 持ち主は、待ちの時点で今の番号に替わる（古い撮りへの停止は、もう届かない）
      CaptureService.owner.claim(args.captureId)
      // 撮っている途中なら、いったん止めてやり直す（中継も止める）
      stopRelay("restart")
      clearPreview()
      if (CaptureService.running) CaptureService.stop(activity)
      val mpm = activity.getSystemService(MediaProjectionManager::class.java)
      startActivityForResult(invoke, mpm.createScreenCaptureIntent(), "captureResult")
    } catch (ex: Exception) {
      gate.take(invoke)
      invoke.reject(ex.message)
    }
  }

  @ActivityCallback
  fun captureResult(invoke: Invoke, result: ActivityResult) {
    // 同じ呼び出しの結果だけを取り出す（違う呼び出しの結果は、待ちを消さない）
    val p = gate.take(invoke)
    if (p == null) {
      invoke.reject("画面の共有がキャンセルされました (cancelled)", "cancelled")
      return
    }
    val data = result.data
    if (result.resultCode != Activity.RESULT_OK || data == null) {
      // ユーザーがダイアログで「キャンセル」を押した。JS 側は code で見分けて、何も知らせずに終える
      CaptureService.owner.release(p.captureId)
      invoke.reject("画面の共有がキャンセルされました (cancelled)", "cancelled")
      return
    }
    val cfg = CaptureConfig.from(p.payload.args, p.payload.relay?.binding)
    try {
      var host: ShareRelayHost? = null
      val rr = p.payload.relay
      if (rr != null) {
        // 許可のあいだに通話が変わっていないか。読めないときは、画面を取らない
        val read = ShareRelayHost.readBinding(activity)
        if (read is BindingRead.Unavailable) {
          CaptureService.owner.release(p.captureId)
          invoke.reject("通話の状態を読めなかったため、画面の共有を始めませんでした", "unavailable")
          return
        }
        val now = RelayPolicy.callOf(read)
        if (now == null || !RelayPolicy.revalidate(rr.binding, read)) {
          CaptureService.owner.release(p.captureId)
          invoke.reject("通話が変わったため、画面の共有をやめました", "call_changed")
          return
        }
        val id = cfg.captureId
        val h = ShareRelayHost(
          activity, rr.config, cfg.fps,
          { CaptureService.lowerQualityForRelay(cfg) },
          { code -> relayEnded(id, code) },
        )
        if (!h.begin(now)) {
          CaptureService.owner.release(p.captureId)
          invoke.reject("通話に参加していないため、画面を中継できません", "not_joined")
          return
        }
        host = h
        relay = h
        relayCaptureId = id
        // 投影を始める直前にも、通話を確かめる（許可から始めるまでのあいだの変化を見逃さない）
        val again = ShareRelayHost.readBinding(activity)
        if (!RelayPolicy.revalidate(rr.binding, again)) {
          stopRelay("call_changed")
          CaptureService.owner.release(p.captureId)
          invoke.reject("通話が変わったため、画面の共有をやめました", "call_changed")
          return
        }
      }
      cfg.relaySink = host?.sink()
      CaptureService.start(activity, result.resultCode, data, cfg)
      invoke.resolve()
    } catch (ex: Exception) {
      stopRelay("start_failed")
      CaptureService.owner.release(p.captureId)
      invoke.reject(ex.message)
    }
  }

  /** 撮る画面の品質と縮小を変える（今の持ち主の番号のものだけ） */
  @Command
  fun updateCapture(invoke: Invoke) {
    val args = invoke.parseArgs(UpdateCaptureArgs::class.java)
    val id = invoke.getArgs().optLong("captureId", 0L)
    if (CaptureService.owner.accepts(id)) {
      CaptureService.update(args.quality, args.scale)
    }
    invoke.resolve()
  }

  @Command
  fun stopCapture(invoke: Invoke) {
    val id = invoke.getArgs().optLong("captureId", 0L)
    // 古い画面への停止は、今の待ち・予約・撮りを止めない
    if (!CaptureService.owner.accepts(id)) {
      invoke.resolve()
      return
    }
    // 許可のダイアログを待っている同じ番号の要求は、ここで取り消す（あとから始まらない）
    gate.cancelIf(id)
    // 開始を頼んだあと、サービスが始まる前の停止も、予約を取り消して止める
    CaptureService.cancelReservation(id)
    stopRelay("user_stop")
    clearPreview()
    CaptureService.stop(activity)
    CaptureService.owner.release(id)
    invoke.resolve()
  }

  /** 中継（送り手）だけを止める。画面は止めない（呼び出し側が決める） */
  private fun stopRelay(reason: String) {
    clearPreview()
    val h = relay ?: return
    relay = null
    h.stop(reason)
  }

  private fun clearPreview() {
    heldPreview = null
  }

  /** 送り手が自分で終わった（通話が終わった・権限・Activity など）。同じ画面なら、画面も止める */
  private fun relayEnded(captureId: Long, code: String) {
    activity.runOnUiThread {
      if (relay == null || captureId != relayCaptureId) return@runOnUiThread
      relay = null
      clearPreview()
      CaptureService.stop(activity)
      deliverEnd(captureId, code)
    }
  }

  /** 画面の撮りが終わった（システムの停止など）。同じ画面の中継なら、送り手も終える */
  private fun onCaptureEnded(captureId: Long, reason: String) {
    if (relay != null && captureId == relayCaptureId) {
      // ログに入る理由は固定の code だけ（例外の文言は JS へ渡すだけで、ネイティブのログには出さない）
      stopRelay(if (reason == "stopped") "capture_stopped" else "capture_error")
    }
    deliverEnd(captureId, reason)
  }

  private fun deliverFrame(f: CapturedFrame) {
    if (webView == null) return
    if (!RelayPolicy.deliverPreview(relay != null, RelayPolicy.previewVisible(resumed, inPip))) {
      heldPreview = f
      relay?.notePreviewSuppressed()
      return
    }
    // 見せる前の確かめ（前面か・番号・中継の状態）は、画面のスレッドの中で行う（後から変わっていても、古い画像を出さない）
    activity.runOnUiThread {
      if (webView == null || !hasListener("capture_frame")) return@runOnUiThread
      // 今の画面の画像だけを見せる（撮りが替わっていたら、古い画像は捨てる）
      if (f.captureId != 0L && f.captureId != CaptureService.owner.current()) return@runOnUiThread
      if (!RelayPolicy.deliverPreview(relay != null, RelayPolicy.previewVisible(resumed, inPip))) {
        // 見えていない間は、閉じたページに溜めない。最新の 1 枚だけを覚えておく
        heldPreview = f
        relay?.notePreviewSuppressed()
        return@runOnUiThread
      }
      val o = JSObject()
      o.put("data", f.data)
      o.put("mime", f.mime)
      o.put("width", f.width)
      o.put("height", f.height)
      o.put("captureId", f.captureId)
      trigger("capture_frame", o)
    }
  }

  private fun deliverEnd(captureId: Long, reason: String) {
    // 同じ画面の終わりは一度だけ知らせる（停止の経路が二つあっても、JS には一つ）
    if (captureId != 0L && captureId == endedCaptureId) return
    endedCaptureId = captureId
    CaptureService.owner.release(captureId)
    if (webView == null) return
    val o = JSObject()
    o.put("reason", reason)
    o.put("captureId", captureId)
    activity.runOnUiThread { trigger("capture_end", o) }
  }

  // ---- 静止画（disnans 自身の画面） ----

  /**
   * disnans 自身の画面（Activity のウィンドウ）を 1 枚だけ撮って JPEG の base64 で返す。
   * MediaProjection は使わないので、許可のダイアログも通知欄の常駐も出ない（ほかのアプリの画面は撮れない）。
   * Android 8 以降は PixelCopy（WebView のハードウェア描画も写る）。PixelCopy が失敗した・真っ黒（空）だったとき、
   * Android 8 未満は View を Canvas に描く（ハードウェア描画の部分は写らないことがある）。
   * 失敗の理由は文言に入れて reject する（JS 側はそのまま利用者に見せる）。応答は必ず 1 回だけ返す
   */
  @Command
  fun snapshot(invoke: Invoke) {
    val args = try {
      invoke.parseArgs(SnapshotArgs::class.java)
    } catch (ex: Exception) {
      SnapshotArgs()
    }
    val done = AtomicBoolean(false)
    val main = Handler(Looper.getMainLooper())
    var timeout: Runnable? = null
    val finish: (Bitmap?, String?) -> Unit = { bmp, error ->
      if (done.compareAndSet(false, true)) {
        timeout?.let { main.removeCallbacks(it) }
        if (bmp != null) {
          Thread({ resolveSnapshot(invoke, bmp, args) }, "disnans-snapshot-encode").start()
        } else {
          invoke.reject("画面を撮れませんでした（${error ?: "原因不明"}）")
        }
      } else {
        bmp?.recycle()
      }
    }
    // PixelCopy の応答が来ないまま待ち続けないようにする
    val onTimeout = Runnable { finish(null, "${SNAPSHOT_TIMEOUT_MS / 1000} 秒待っても画面の画像が届きませんでした") }
    timeout = onTimeout
    main.postDelayed(onTimeout, SNAPSHOT_TIMEOUT_MS)
    main.post {
      try {
        if (activity.isFinishing || activity.isDestroyed) {
          finish(null, "アプリの画面が閉じられています")
          return@post
        }
        val window = activity.window
        val decor = window?.peekDecorView()
        if (window == null || decor == null || !decor.isAttachedToWindow) {
          finish(null, "アプリの画面がまだ表示されていません")
          return@post
        }
        val w = decor.width
        val h = decor.height
        if (w <= 0 || h <= 0) {
          finish(null, "アプリの画面の大きさが 0 です（まだ表示されていません）")
          return@post
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          pixelCopy(window, w, h) { bmp, error ->
            if (bmp != null) {
              finish(bmp, null)
            } else {
              // PixelCopy が使えなかったときは View を描いてみる（UI スレッドで）
              main.post {
                val (drawn, drawError) = drawView(decor, w, h)
                finish(drawn, if (drawn == null) "$error。代わりの方法も失敗: $drawError" else null)
              }
            }
          }
        } else {
          val (drawn, drawError) = drawView(decor, w, h)
          finish(drawn, drawError)
        }
      } catch (t: Throwable) {
        finish(null, describeThrowable(t))
      }
    }
  }

  /** PixelCopy でウィンドウを撮る（Android 8 以降、UI スレッドで呼ぶ）。結果は別のスレッドで cb に渡る */
  @androidx.annotation.RequiresApi(Build.VERSION_CODES.O)
  private fun pixelCopy(window: android.view.Window, w: Int, h: Int, cb: (Bitmap?, String?) -> Unit) {
    val bmp = try {
      Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    } catch (t: Throwable) {
      cb(null, "画像の領域を確保できません（${w}×${h}、${describeThrowable(t)}）")
      return
    }
    val thread = HandlerThread("disnans-snapshot").apply { start() }
    try {
      PixelCopy.request(window, bmp, { result ->
        thread.quitSafely()
        when {
          result != PixelCopy.SUCCESS -> {
            bmp.recycle()
            cb(null, "PixelCopy が失敗: ${pixelCopyError(result)}")
          }
          isBlank(bmp) -> {
            bmp.recycle()
            cb(null, "PixelCopy の画像が真っ黒（空）でした")
          }
          else -> cb(bmp, null)
        }
      }, Handler(thread.looper))
    } catch (t: Throwable) {
      thread.quitSafely()
      bmp.recycle()
      cb(null, "PixelCopy を使えません（${describeThrowable(t)}）")
    }
  }

  /** View を Canvas に描く（UI スレッドで呼ぶ）。WebView のハードウェア描画の部分は写らないことがある */
  private fun drawView(view: android.view.View, w: Int, h: Int): Pair<Bitmap?, String?> {
    return try {
      val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
      view.draw(Canvas(bmp))
      if (isBlank(bmp)) {
        bmp.recycle()
        Pair(null, "画面を描いた画像が真っ黒（空）でした")
      } else {
        Pair(bmp, null)
      }
    } catch (t: Throwable) {
      Pair(null, "画面を描けません（${describeThrowable(t)}）")
    }
  }

  /** 縮小して JPEG にし、`{ data, mime, width, height }` で返す（UI スレッドの外で呼ぶ） */
  private fun resolveSnapshot(invoke: Invoke, src: Bitmap, args: SnapshotArgs) {
    try {
      val maxEdge = args.maxEdge.coerceIn(64, 4096)
      val scale = minOf(1.0, maxEdge.toDouble() / maxOf(src.width, src.height))
      val bmp = if (scale < 1.0) {
        val w = (src.width * scale).toInt().coerceAtLeast(1)
        val h = (src.height * scale).toInt().coerceAtLeast(1)
        Bitmap.createScaledBitmap(src, w, h, true).also { if (it !== src) src.recycle() }
      } else {
        src
      }
      val out = ByteArrayOutputStream()
      if (!bmp.compress(Bitmap.CompressFormat.JPEG, (args.quality * 100).toInt().coerceIn(1, 100), out)) {
        bmp.recycle()
        invoke.reject("画面を撮れませんでした（JPEG にできませんでした）")
        return
      }
      val o = JSObject()
      o.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP))
      o.put("mime", "image/jpeg")
      o.put("width", bmp.width)
      o.put("height", bmp.height)
      bmp.recycle()
      invoke.resolve(o)
    } catch (t: Throwable) {
      invoke.reject("画面を撮れませんでした（画像にできません: ${describeThrowable(t)}）")
    }
  }

  /** 全面がほぼ同じ色（真っ黒・透明など）か。間引いて調べる */
  private fun isBlank(bmp: Bitmap): Boolean {
    val stepX = maxOf(1, bmp.width / 24)
    val stepY = maxOf(1, bmp.height / 24)
    val first = bmp.getPixel(0, 0)
    var y = 0
    while (y < bmp.height) {
      var x = 0
      while (x < bmp.width) {
        if (bmp.getPixel(x, y) != first) return false
        x += stepX
      }
      y += stepY
    }
    // 全面が同じ色でも、不透明な明るい色（白い画面など）は撮れたものとみなす
    val alpha = first ushr 24
    val rgb = first and 0xFFFFFF
    return alpha == 0 || rgb == 0
  }

  private fun pixelCopyError(result: Int): String = when (result) {
    PixelCopy.ERROR_UNKNOWN -> "不明なエラー (ERROR_UNKNOWN)"
    PixelCopy.ERROR_TIMEOUT -> "時間切れ (ERROR_TIMEOUT)"
    PixelCopy.ERROR_SOURCE_NO_DATA -> "画面がまだ描かれていません (ERROR_SOURCE_NO_DATA)"
    PixelCopy.ERROR_SOURCE_INVALID -> "画面を読めません (ERROR_SOURCE_INVALID)"
    PixelCopy.ERROR_DESTINATION_INVALID -> "画像の領域が不正です (ERROR_DESTINATION_INVALID)"
    else -> "コード $result"
  }

  private fun describeThrowable(t: Throwable): String {
    if (t is OutOfMemoryError) return "メモリが足りません"
    val msg = t.message
    return if (msg.isNullOrBlank()) t.javaClass.simpleName else "${t.javaClass.simpleName}: $msg"
  }

  // ---- ピクチャーインピクチャー ----

  /** Activity を小窓にする。入れなければ entered=false（Android 8 未満、デバイスが非対応、ユーザーが禁止しているなど） */
  @Command
  fun enterPip(invoke: Invoke) {
    val args = invoke.parseArgs(EnterPipArgs::class.java)
    val ret = JSObject()
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
      !activity.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)
    ) {
      ret.put("entered", false)
      invoke.resolve(ret)
      return
    }
    activity.runOnUiThread {
      try {
        // 縦横比は 1:2.39〜2.39:1 に収める必要がある
        val ratio = (args.width.toDouble() / args.height.coerceAtLeast(1)).coerceIn(1.0 / 2.39, 2.39)
        val params = PictureInPictureParams.Builder()
          .setAspectRatio(Rational((ratio * 1000).toInt(), 1000))
          .build()
        ret.put("entered", activity.enterPictureInPictureMode(params))
        invoke.resolve(ret)
      } catch (ex: Exception) {
        invoke.reject(ex.message)
      }
    }
  }
}
