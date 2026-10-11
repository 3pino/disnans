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

  /** 許可のダイアログの結果を待っている間の設定 */
  private var pendingArgs: StartCaptureArgs? = null

  /** いま小窓になっている */
  @Volatile private var inPip = false

  private val pipListener = Consumer<PictureInPictureModeChangedInfo> { info ->
    inPip = info.isInPictureInPictureMode
    val o = JSObject()
    o.put("active", inPip)
    trigger("pip_change", o)
  }

  override fun load(webView: WebView) {
    this.webView = webView
    CaptureService.frameSink = { frame -> deliverFrame(frame) }
    CaptureService.endSink = { reason -> deliverEnd(reason) }
    (activity as? OnPictureInPictureModeChangedProvider)?.addOnPictureInPictureModeChangedListener(pipListener)
  }

  override fun onDestroy() {
    CaptureService.frameSink = null
    CaptureService.endSink = null
    (activity as? OnPictureInPictureModeChangedProvider)?.removeOnPictureInPictureModeChangedListener(pipListener)
    CaptureService.stop(activity)
  }

  /**
   * 小窓の間は Activity が onPause になり、WebView が止まって映像の更新が止まる。
   * 通話中の WebView を保つ処理（NotifierPlugin.onPause）と同じく、小窓のあいだは動かし直す
   */
  override fun onPause() {
    if (inPip) {
      webView?.onResume()
      webView?.resumeTimers()
    }
  }

  // ---- 画面のキャプチャ ----

  /** OS の確認のダイアログ（画面の録画の許可）を出し、許可されたらサービスで撮り始める */
  @Command
  fun startCapture(invoke: Invoke) {
    val args = invoke.parseArgs(StartCaptureArgs::class.java)
    try {
      // 撮っている途中なら、いったん止めてやり直す
      if (CaptureService.running) CaptureService.stop(activity)
      pendingArgs = args
      val mpm = activity.getSystemService(MediaProjectionManager::class.java)
      startActivityForResult(invoke, mpm.createScreenCaptureIntent(), "captureResult")
    } catch (ex: Exception) {
      invoke.reject(ex.message)
    }
  }

  @ActivityCallback
  fun captureResult(invoke: Invoke, result: ActivityResult) {
    val args = pendingArgs
    pendingArgs = null
    val data = result.data
    if (result.resultCode != Activity.RESULT_OK || data == null || args == null) {
      // ユーザーがダイアログで「キャンセル」を押した。JS 側は code で見分けて、何も知らせずに終える
      invoke.reject("画面の共有がキャンセルされました (cancelled)", "cancelled")
      return
    }
    try {
      CaptureService.start(activity, result.resultCode, data, CaptureConfig.from(args))
      invoke.resolve()
    } catch (ex: Exception) {
      invoke.reject(ex.message)
    }
  }

  /** 撮りながら品質と縮小の倍率を変える */
  @Command
  fun updateCapture(invoke: Invoke) {
    val args = invoke.parseArgs(UpdateCaptureArgs::class.java)
    CaptureService.update(args.quality, args.scale)
    invoke.resolve()
  }

  @Command
  fun stopCapture(invoke: Invoke) {
    CaptureService.stop(activity)
    invoke.resolve()
  }

  private fun deliverFrame(f: CapturedFrame) {
    if (webView == null || !hasListener("capture_frame")) return
    val o = JSObject()
    o.put("data", f.data)
    o.put("mime", f.mime)
    o.put("width", f.width)
    o.put("height", f.height)
    activity.runOnUiThread { trigger("capture_frame", o) }
  }

  private fun deliverEnd(reason: String) {
    val o = JSObject()
    o.put("reason", reason)
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

  /** Activity を小窓にする。入れなければ entered=false（Android 8 未満、端末が非対応、ユーザーが禁止しているなど） */
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
