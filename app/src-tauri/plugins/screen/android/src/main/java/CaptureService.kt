package dev.disnans.screen

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.SystemClock
import android.util.Base64
import android.util.DisplayMetrics
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.io.ByteArrayOutputStream
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** 撮り方の設定。品質と縮小の倍率だけは、撮りながら変えられる */
class CaptureConfig(
  val maxEdge: Int,
  val fps: Int,
  val format: String,
  val color: String,
  val diffThreshold: Double,
  val keepaliveMs: Long,
  @Volatile var quality: Double,
  @Volatile var scale: Double = 1.0,
) {
  companion object {
    fun from(a: StartCaptureArgs) = CaptureConfig(
      maxEdge = a.maxEdge.coerceIn(160, 4096),
      fps = a.fps.coerceIn(1, 30),
      format = a.format,
      color = a.color,
      diffThreshold = a.diffThreshold,
      keepaliveMs = a.keepaliveMs.coerceAtLeast(500),
      quality = a.quality.coerceIn(0.1, 1.0),
    )
  }
}

class CapturedFrame(val data: String, val mime: String, val width: Int, val height: Int)

/**
 * 画面のキャプチャ（MediaProjection）を行うフォアグラウンドサービス（foregroundServiceType=mediaProjection）。
 * VirtualDisplay を縮小したサイズで作り、変化があったフレーム（と、変わらなくても一定時間ごとに 1 枚）を
 * JPEG / WebP / PNG にして base64 で frameSink に渡す。
 * Android 14 以降は、startForeground したあとでないと getMediaProjection を呼べない。
 */
class CaptureService : Service() {
  companion object {
    private const val CHANNEL = "screen_capture"
    private const val ONGOING_ID = 7301
    private const val ACTION_STOP = "dev.disnans.screen.STOP_CAPTURE"
    /** 形式を選び直す間隔（フレーム数）。減色・グレースケールのとき、候補を全部試して小さいものを選ぶ */
    private const val PROBE_EVERY = 30
    private const val DIFF_W = 32
    private const val DIFF_H = 18

    @Volatile var running = false
    var frameSink: ((CapturedFrame) -> Unit)? = null
    var endSink: ((String) -> Unit)? = null

    private var pendingCode = 0
    private var pendingData: Intent? = null
    private var pendingConfig: CaptureConfig? = null
    @Volatile private var activeConfig: CaptureConfig? = null

    fun start(context: Context, resultCode: Int, data: Intent, config: CaptureConfig) {
      pendingCode = resultCode
      pendingData = data
      pendingConfig = config
      ContextCompat.startForegroundService(context, Intent(context, CaptureService::class.java))
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, CaptureService::class.java))
    }

    fun update(quality: Double?, scale: Double?) {
      val c = activeConfig ?: return
      if (quality != null) c.quality = quality.coerceIn(0.1, 1.0)
      if (scale != null) c.scale = scale.coerceIn(0.2, 1.0)
    }

    /** 画素（ARGB）の色数を減らす。JS の applyColorMode と同じ計算 */
    fun applyColor(px: IntArray, mode: String) {
      if (mode == "c256") {
        for (i in px.indices) {
          val p = px[i]
          val r = (p shr 16) and 0xff
          val g = (p shr 8) and 0xff
          val b = p and 0xff
          val r2 = ((r shr 5) * 255 / 7.0).roundToInt()
          val g2 = ((g shr 5) * 255 / 7.0).roundToInt()
          val b2 = ((b shr 6) * 255 / 3.0).roundToInt()
          px[i] = (0xff shl 24) or (r2 shl 16) or (g2 shl 8) or b2
        }
      } else if (mode == "gray") {
        for (i in px.indices) {
          val p = px[i]
          val y = ((((p shr 16) and 0xff) * 299 + ((p shr 8) and 0xff) * 587 + (p and 0xff) * 114) / 1000)
          px[i] = (0xff shl 24) or (y shl 16) or (y shl 8) or y
        }
      }
    }
  }

  private var projection: MediaProjection? = null
  private var display: VirtualDisplay? = null
  private var reader: ImageReader? = null
  private var thread: HandlerThread? = null
  private var handler: Handler? = null
  private var config: CaptureConfig? = null

  // 以下はすべてキャプチャのスレッド（handler）で触る
  private var width = 0
  private var height = 0
  private var latest: Bitmap? = null
  private var prevSample: IntArray? = null
  private var lastSentAt = 0L
  private var lastProcessAt = 0L
  private var processScheduled = false
  private var framesSinceProbe = 0
  private var format: String? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      endSink?.invoke("stopped")
      stopSelf()
      return START_NOT_STICKY
    }
    val data = pendingData
    val cfg = pendingConfig
    if (data == null || cfg == null) {
      stopSelf()
      return START_NOT_STICKY
    }
    pendingData = null
    pendingConfig = null
    createChannel()
    val n = notification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(ONGOING_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
    } else {
      startForeground(ONGOING_ID, n)
    }
    try {
      begin(pendingCode, data, cfg)
    } catch (e: Exception) {
      endSink?.invoke(e.message ?: "error")
      stopSelf()
      return START_NOT_STICKY
    }
    // 強制終了されたあとに勝手に再開しない（許可のダイアログをもう一度出す必要がある）
    return START_NOT_STICKY
  }

  private fun begin(code: Int, data: Intent, cfg: CaptureConfig) {
    val mpm = getSystemService(MediaProjectionManager::class.java)
    val p = mpm.getMediaProjection(code, data) ?: throw IllegalStateException("画面を取得できません")
    projection = p
    config = cfg
    activeConfig = cfg
    val t = HandlerThread("disnans-screen-capture").also { it.start() }
    thread = t
    val h = Handler(t.looper)
    handler = h
    // Android 14 以降は、VirtualDisplay を作る前にコールバックを登録する必要がある
    p.registerCallback(object : MediaProjection.Callback() {
      override fun onStop() {
        // 画面の共有がシステム側（ステータスバーのチップなど）で止められた
        h.post {
          endSink?.invoke("stopped")
          stopSelf()
        }
      }
    }, h)

    val metrics = realMetrics()
    val r = min(1.0, cfg.maxEdge.toDouble() / max(metrics.widthPixels, metrics.heightPixels))
    width = max(2, ((metrics.widthPixels * r).roundToInt()) and 1.inv())
    height = max(2, ((metrics.heightPixels * r).roundToInt()) and 1.inv())
    val ir = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
    reader = ir
    ir.setOnImageAvailableListener({ rd -> onImage(rd) }, h)
    display = p.createVirtualDisplay(
      "disnans-screen",
      width,
      height,
      metrics.densityDpi,
      DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
      ir.surface,
      null,
      h,
    )
    running = true
    // 画面が変わらないと新しいフレームは来ないので、一定時間ごとに最後のフレームを送り直す
    h.postDelayed(keepaliveTask, cfg.keepaliveMs)
  }

  private fun realMetrics(): DisplayMetrics {
    val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
    val m = DisplayMetrics()
    @Suppress("DEPRECATION")
    wm.defaultDisplay.getRealMetrics(m)
    return m
  }

  private val keepaliveTask = object : Runnable {
    override fun run() {
      val c = config ?: return
      if (latest != null && SystemClock.elapsedRealtime() - lastSentAt >= c.keepaliveMs) process(force = true)
      handler?.postDelayed(this, c.keepaliveMs / 2)
    }
  }

  /** 新しい画面が来た。最新の 1 枚だけを覚え、fps の間隔で処理する */
  private fun onImage(rd: ImageReader) {
    val image = try {
      rd.acquireLatestImage()
    } catch (e: Exception) {
      null
    } ?: return
    try {
      val plane = image.planes[0]
      val rowPixels = plane.rowStride / plane.pixelStride
      val full = Bitmap.createBitmap(rowPixels, height, Bitmap.Config.ARGB_8888)
      full.copyPixelsFromBuffer(plane.buffer)
      // 行の余白を切る
      val bmp = if (rowPixels == width) full else Bitmap.createBitmap(full, 0, 0, width, height).also { full.recycle() }
      latest?.recycle()
      latest = bmp
    } finally {
      image.close()
    }
    schedule()
  }

  private fun schedule() {
    val c = config ?: return
    if (processScheduled) return
    val wait = (1000L / c.fps) - (SystemClock.elapsedRealtime() - lastProcessAt)
    if (wait <= 0) {
      process(force = false)
    } else {
      processScheduled = true
      handler?.postDelayed({
        processScheduled = false
        process(force = false)
      }, wait)
    }
  }

  /** 最新のフレームを、変化があれば（force なら必ず）符号化して渡す */
  private fun process(force: Boolean) {
    val c = config ?: return
    val bmp = latest ?: return
    val now = SystemClock.elapsedRealtime()
    lastProcessAt = now
    val sample = sampleOf(bmp)
    val diff = diffOf(prevSample, sample)
    if (!force && diff <= c.diffThreshold && now - lastSentAt < c.keepaliveMs) return
    prevSample = sample
    val sink = frameSink ?: return
    val frame = encode(bmp, c) ?: return
    lastSentAt = now
    sink(frame)
  }

  /** 変化の判定に使う小さな標本（格子状に DIFF_W×DIFF_H 点の RGB） */
  private fun sampleOf(b: Bitmap): IntArray {
    val out = IntArray(DIFF_W * DIFF_H)
    for (y in 0 until DIFF_H) {
      for (x in 0 until DIFF_W) {
        out[y * DIFF_W + x] = b.getPixel((x * 2 + 1) * b.width / (DIFF_W * 2), (y * 2 + 1) * b.height / (DIFF_H * 2))
      }
    }
    return out
  }

  private fun diffOf(a: IntArray?, b: IntArray): Double {
    if (a == null || a.size != b.size) return Double.MAX_VALUE
    var sum = 0L
    for (i in b.indices) {
      sum += abs(((a[i] shr 16) and 0xff) - ((b[i] shr 16) and 0xff)) +
        abs(((a[i] shr 8) and 0xff) - ((b[i] shr 8) and 0xff)) +
        abs((a[i] and 0xff) - (b[i] and 0xff))
    }
    return sum.toDouble() / (b.size * 3)
  }

  private fun encode(src: Bitmap, c: CaptureConfig): CapturedFrame? {
    var bmp = src
    var scaled: Bitmap? = null
    var work: Bitmap? = null
    try {
      if (c.scale < 0.999) {
        scaled = Bitmap.createScaledBitmap(src, max(2, (src.width * c.scale).roundToInt()), max(2, (src.height * c.scale).roundToInt()), true)
        bmp = scaled
      }
      if (c.color != "full") {
        work = bmp.copy(Bitmap.Config.ARGB_8888, true)
        val px = IntArray(work.width * work.height)
        work.getPixels(px, 0, work.width, 0, 0, work.width, work.height)
        applyColor(px, c.color)
        work.setPixels(px, 0, work.width, 0, 0, work.width, work.height)
        bmp = work
      }
      val q = (c.quality * 100).roundToInt().coerceIn(10, 100)
      val lossyWebp = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) Bitmap.CompressFormat.WEBP_LOSSY else @Suppress("DEPRECATION") Bitmap.CompressFormat.WEBP
      val lossless = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) Bitmap.CompressFormat.WEBP_LOSSLESS else Bitmap.CompressFormat.PNG
      // 候補（キー: 名前 → 形式と MIME）。フルカラーは設定の形式だけ。減色は可逆のほうが小さいことが多いので、両方試す
      val candidates: List<String> = when (c.color) {
        "c256" -> listOf("lossless", "webp")
        "gray" -> listOf("jpeg", "webp")
        else -> listOf(if (c.format == "webp") "webp" else "jpeg")
      }
      fun run(name: String): Pair<ByteArray, String> {
        val out = ByteArrayOutputStream()
        val (fmt, mime) = when (name) {
          "jpeg" -> Bitmap.CompressFormat.JPEG to "image/jpeg"
          "webp" -> lossyWebp to "image/webp"
          else -> lossless to (if (lossless == Bitmap.CompressFormat.PNG) "image/png" else "image/webp")
        }
        bmp.compress(fmt, q, out)
        return out.toByteArray() to mime
      }
      val chosen = format
      val probe = candidates.size > 1 && (chosen == null || framesSinceProbe >= PROBE_EVERY)
      val result: Pair<ByteArray, String>
      if (probe) {
        val results = candidates.map { it to run(it) }
        val best = results.minByOrNull { it.second.first.size }!!
        format = best.first
        framesSinceProbe = 0
        result = best.second
      } else {
        result = run(if (candidates.size == 1) candidates[0] else chosen ?: candidates[0])
        framesSinceProbe++
      }
      return CapturedFrame(Base64.encodeToString(result.first, Base64.NO_WRAP), result.second, bmp.width, bmp.height)
    } catch (e: Exception) {
      return null
    } finally {
      scaled?.recycle()
      work?.recycle()
    }
  }

  override fun onDestroy() {
    running = false
    activeConfig = null
    handler?.removeCallbacksAndMessages(null)
    try {
      display?.release()
    } catch (_: Exception) {
    }
    try {
      reader?.close()
    } catch (_: Exception) {
    }
    try {
      projection?.stop()
    } catch (_: Exception) {
    }
    latest?.recycle()
    latest = null
    thread?.quitSafely()
    display = null
    reader = null
    projection = null
    thread = null
    handler = null
    stopForeground(STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }

  private fun notification(): Notification {
    val open = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    } ?: Intent()
    val pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val stop = PendingIntent.getService(
      this,
      1,
      Intent(this, CaptureService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    // 通話の通知（notifier プラグイン）のアイコンがあれば同じものを使う
    val icon = resources.getIdentifier("disnans_notification", "drawable", packageName)
      .takeIf { it != 0 } ?: android.R.drawable.ic_menu_view
    return NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(icon)
      .setContentTitle("画面を共有しています")
      .setContentText("止めるには、通話のバーの共有ボタンか、この通知の「停止」を押します")
      .setOngoing(true)
      .setShowWhen(false)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setContentIntent(pi)
      .addAction(0, "停止", stop)
      .build()
  }

  private fun createChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    getSystemService(NotificationManager::class.java).createNotificationChannel(
      NotificationChannel(CHANNEL, "画面共有", NotificationManager.IMPORTANCE_LOW).apply {
        description = "画面を共有している間、表示する"
        setShowBadge(false)
      }
    )
  }
}
