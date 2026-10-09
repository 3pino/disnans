package dev.disnans.notifier

import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * 通知用の常駐サービス。WebView とは別にサーバーの WebSocket につなぎ、`notify` を受け取ったら
 * システム通知を出す。アプリが前面にあるときは、アプリ（WebView）側の表示に任せる。
 */
class NotifyService : Service() {
  companion object {
    private const val TAG = "disnans"
    private const val CHANNEL_MESSAGES = "messages"
    private const val CHANNEL_CONNECTION = "connection"
    private const val ONGOING_ID = 1
    private const val BACKOFF_BASE_MS = 1_000L
    private const val BACKOFF_MAX_MS = 60_000L

    /** 通知を開いたときにアプリへ渡す値 */
    const val EXTRA_OPEN = "dev.disnans.notifier.OPEN"
    const val EXTRA_THREAD_ID = "dev.disnans.notifier.THREAD_ID"

    @Volatile var running = false
      private set
    @Volatile var connected = false
      private set

    fun start(context: Context) {
      ContextCompat.startForegroundService(context, Intent(context, NotifyService::class.java))
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, NotifyService::class.java))
    }

    fun createChannels(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val nm = context.getSystemService(NotificationManager::class.java)
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL_MESSAGES, "メッセージ", NotificationManager.IMPORTANCE_HIGH).apply {
          description = "メンションやスレッドへの返信"
        }
      )
      // 常に出ている「接続中」の通知。目立たないよう最低の重要度にする（設定から非表示にもできる）
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL_CONNECTION, "常駐接続", NotificationManager.IMPORTANCE_MIN).apply {
          description = "通知を受け取るためにサーバーとつないでいることを示す"
          setShowBadge(false)
        }
      )
    }
  }

  private val handler = Handler(Looper.getMainLooper())
  private val client = OkHttpClient.Builder()
    // 途中の経路で切れたことに気づけるよう、定期的に ping を送る
    .pingInterval(30, TimeUnit.SECONDS)
    .readTimeout(0, TimeUnit.MILLISECONDS)
    .build()
  private var socket: WebSocket? = null
  private var attempt = 0
  private var stopped = false
  private val reconnect = Runnable { connect() }
  private var networkCallback: ConnectivityManager.NetworkCallback? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    createChannels(this)
    startInForeground()
    running = true
    watchNetwork()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // サーバーの URL が変わったときにも呼ばれるので、つなぎ直す
    stopped = false
    attempt = 0
    socket?.cancel()
    socket = null
    connect()
    return START_STICKY
  }

  override fun onDestroy() {
    stopped = true
    running = false
    connected = false
    handler.removeCallbacks(reconnect)
    socket?.close(1000, null)
    socket = null
    networkCallback?.let {
      getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it)
    }
    super.onDestroy()
  }

  private fun startInForeground() {
    val n = ongoingNotification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(ONGOING_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
    } else {
      startForeground(ONGOING_ID, n)
    }
  }

  private fun ongoingNotification(): Notification =
    NotificationCompat.Builder(this, CHANNEL_CONNECTION)
      .setSmallIcon(R.drawable.disnans_notification)
      .setContentTitle(if (connected) "通知を受け取っています" else "サーバーに接続しています…")
      .setOngoing(true)
      .setShowWhen(false)
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .setContentIntent(openAppIntent(0, null))
      .build()

  private fun setConnected(value: Boolean) {
    if (connected == value) return
    connected = value
    if (running) getSystemService(NotificationManager::class.java).notify(ONGOING_ID, ongoingNotification())
  }

  /** ネットワークが戻ったら、待たずにつなぎ直す */
  private fun watchNetwork() {
    val cb = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        handler.post {
          if (!stopped && !connected) {
            handler.removeCallbacks(reconnect)
            attempt = 0
            connect()
          }
        }
      }
    }
    try {
      getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(cb)
      networkCallback = cb
    } catch (ex: Exception) {
      Log.w(TAG, "ネットワークの監視を始められませんでした", ex)
    }
  }

  private fun connect() {
    handler.removeCallbacks(reconnect)
    if (stopped) return
    val base = Prefs(this).serverUrl
    if (base.isNullOrEmpty()) {
      stopSelf()
      return
    }
    socket?.cancel()
    val url = base.replaceFirst(Regex("^http", RegexOption.IGNORE_CASE), "ws") + "/api/ws"
    val request = try {
      Request.Builder().url(url).build()
    } catch (ex: IllegalArgumentException) {
      Log.w(TAG, "サーバーの URL が不正です: $base", ex)
      stopSelf()
      return
    }
    socket = client.newWebSocket(request, Listener())
  }

  private fun scheduleReconnect() {
    if (stopped) return
    val delay = minOf(BACKOFF_MAX_MS, BACKOFF_BASE_MS shl minOf(attempt, 6))
    attempt++
    handler.removeCallbacks(reconnect)
    handler.postDelayed(reconnect, delay)
  }

  private inner class Listener : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
      handler.post {
        if (webSocket !== socket) return@post
        attempt = 0
        setConnected(true)
      }
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      try {
        val ev = JSONObject(text)
        if (ev.optString("type") == "notify") handler.post { onNotify(ev) }
      } catch (ex: Exception) {
        Log.w(TAG, "イベントを読めませんでした", ex)
      }
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = lost(webSocket)

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = lost(webSocket)

    private fun lost(webSocket: WebSocket) {
      handler.post {
        if (webSocket !== socket) return@post
        socket = null
        setConnected(false)
        scheduleReconnect()
      }
    }
  }

  private fun onNotify(ev: JSONObject) {
    val sample = ev.optBoolean("sample", false)
    // アプリが前面にあるときは、アプリ内の表示に任せる（サンプルは確認用なので必ず出す）
    if (!sample && isAppInForeground()) return

    val title = ev.optString("title")
    val body = ev.optString("body")
    val messageId = ev.optNullableString("message_id")
    val threadId = ev.optNullableString("thread_id")
    val id = (messageId ?: "sample-${System.currentTimeMillis()}").hashCode()

    val n = NotificationCompat.Builder(this, CHANNEL_MESSAGES)
      .setSmallIcon(R.drawable.disnans_notification)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setAutoCancel(true)
      .setContentIntent(openAppIntent(id, threadId))
      .build()
    try {
      getSystemService(NotificationManager::class.java).notify(id, n)
    } catch (ex: SecurityException) {
      // 通知が許可されていない
      Log.w(TAG, "通知を出せませんでした", ex)
    }
  }

  private fun openAppIntent(requestCode: Int, threadId: String?): PendingIntent {
    val intent = (packageManager.getLaunchIntentForPackage(packageName) ?: Intent()).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      if (requestCode != 0) {
        putExtra(EXTRA_OPEN, true)
        putExtra(EXTRA_THREAD_ID, threadId)
      }
    }
    return PendingIntent.getActivity(
      this,
      requestCode,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  /** アクティビティが画面に出ているか（このサービスだけが動いているときは FOREGROUND_SERVICE になる） */
  private fun isAppInForeground(): Boolean {
    val info = ActivityManager.RunningAppProcessInfo()
    ActivityManager.getMyMemoryState(info)
    return info.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
  }
}

private fun JSONObject.optNullableString(key: String): String? =
  if (isNull(key)) null else optString(key)
