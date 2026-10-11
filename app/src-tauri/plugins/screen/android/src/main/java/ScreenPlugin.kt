package dev.disnans.screen

import android.app.Activity
import android.app.PictureInPictureParams
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Handler
import android.os.HandlerThread
import android.util.Base64
import android.view.PixelCopy
import java.io.ByteArrayOutputStream
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
   * Android 8 以降は PixelCopy（WebView のハードウェア描画も写る）、それ未満は View を Canvas に描く
   */
  @Command
  fun snapshot(invoke: Invoke) {
    val args = invoke.parseArgs(SnapshotArgs::class.java)
    activity.runOnUiThread {
      try {
        val window = activity.window
        val decor = window.decorView
        val w = decor.width
        val h = decor.height
        if (w <= 0 || h <= 0) {
          invoke.reject("画面がまだ表示されていません")
          return@runOnUiThread
        }
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          val thread = HandlerThread("disnans-snapshot").apply { start() }
          try {
            PixelCopy.request(window, bmp, { result ->
              thread.quitSafely()
              if (result == PixelCopy.SUCCESS) {
                resolveSnapshot(invoke, bmp, args)
              } else {
                bmp.recycle()
                invoke.reject("画面を撮れませんでした（PixelCopy: $result）")
              }
            }, Handler(thread.looper))
          } catch (ex: Exception) {
            thread.quitSafely()
            bmp.recycle()
            invoke.reject(ex.message ?: "画面を撮れませんでした")
          }
        } else {
          decor.draw(Canvas(bmp))
          Thread { resolveSnapshot(invoke, bmp, args) }.start()
        }
      } catch (ex: Exception) {
        invoke.reject(ex.message ?: "画面を撮れませんでした")
      }
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
        Bitmap.createScaledBitmap(src, w, h, true).also { src.recycle() }
      } else {
        src
      }
      val out = ByteArrayOutputStream()
      bmp.compress(Bitmap.CompressFormat.JPEG, (args.quality * 100).toInt().coerceIn(1, 100), out)
      val o = JSObject()
      o.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP))
      o.put("mime", "image/jpeg")
      o.put("width", bmp.width)
      o.put("height", bmp.height)
      bmp.recycle()
      invoke.resolve(o)
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "画像にできませんでした")
    }
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
