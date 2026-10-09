package dev.disnans.notifier

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * 通話など、画面を消してもマイクを使い続けるためのフォアグラウンドサービス（microphone 型）。
 * 中身は何もしない。サービスが動いている間、プロセスと WebView（WebRTC）が止められにくくなる。
 * マイクの許可（RECORD_AUDIO）を得たあと、アプリが前面にあるときに始めること（Android 14 以降の決まり）。
 */
class CallService : Service() {
  companion object {
    private const val CHANNEL_CALL = "call"
    private const val ONGOING_ID = 2
    private const val EXTRA_TITLE = "title"
    private const val EXTRA_TEXT = "text"
    private const val EXTRA_MICROPHONE = "microphone"

    @Volatile var running = false
      private set

    fun start(context: Context, title: String, text: String, microphone: Boolean) {
      val intent = Intent(context, CallService::class.java)
        .putExtra(EXTRA_TITLE, title)
        .putExtra(EXTRA_TEXT, text)
        .putExtra(EXTRA_MICROPHONE, microphone)
      ContextCompat.startForegroundService(context, intent)
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, CallService::class.java))
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val title = intent?.getStringExtra(EXTRA_TITLE).orEmpty().ifEmpty { "通話" }
    val text = intent?.getStringExtra(EXTRA_TEXT).orEmpty()
    val microphone = intent?.getBooleanExtra(EXTRA_MICROPHONE, true) ?: true
    createChannel(this)
    val n = notification(title, text)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val type = if (microphone) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
      startForeground(ONGOING_ID, n, type)
    } else {
      startForeground(ONGOING_ID, n)
    }
    running = true
    // 強制終了されたあとに勝手に再開しない（マイクの許可や前面の条件を満たせないため）
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    running = false
    super.onDestroy()
  }

  private fun notification(title: String, text: String): Notification {
    val open = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    } ?: Intent()
    val pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    return NotificationCompat.Builder(this, CHANNEL_CALL)
      .setSmallIcon(R.drawable.disnans_notification)
      .setContentTitle(title)
      .setContentText(text)
      .setOngoing(true)
      .setShowWhen(false)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setContentIntent(pi)
      .build()
  }

  private fun createChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    context.getSystemService(NotificationManager::class.java).createNotificationChannel(
      NotificationChannel(CHANNEL_CALL, "通話", NotificationManager.IMPORTANCE_LOW).apply {
        description = "通話中であることを示す"
        setShowBadge(false)
      }
    )
  }
}
