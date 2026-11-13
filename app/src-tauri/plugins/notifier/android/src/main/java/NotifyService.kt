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
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

/**
 * 通知用の常駐サービス。WebView とは別にサーバーの WebSocket につなぎ、`notify` を受け取ったら
 * システム通知を出す。アプリが前面にあるときは、アプリ（WebView）側の表示に任せる。
 */
class NotifyService : Service() {
  companion object {
    private const val CHANNEL_MESSAGES = "messages"
    private const val CHANNEL_CONNECTION = "connection"
    private const val ONGOING_ID = 1
    private const val BACKOFF_BASE_MS = 1_000L
    private const val BACKOFF_MAX_MS = 60_000L

    /** 通知を開いたときにアプリへ渡す値 */
    const val EXTRA_OPEN = "dev.disnans.notifier.OPEN"

    @Volatile var running = false
      private set
    @Volatile var connected = false
      private set

    fun start(context: Context) {
      ContextCompat.startForegroundService(context, Intent(context, NotifyService::class.java))
    }

    private const val ASK_OPEN_ID = 3

    /**
     * 起動時に常駐を始められなかったとき、アプリを開いてもらうよう一度だけ知らせる。
     * アプリを開くと TS 側の初期化が常駐を始め直す（通知を受け取れるようになる）。
     */
    fun askToOpen(context: Context) {
      createChannels(context)
      val open = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
      val pi = PendingIntent.getActivity(
        context,
        ASK_OPEN_ID,
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
      val n = NotificationCompat.Builder(context, CHANNEL_MESSAGES)
        .setSmallIcon(R.drawable.disnans_notification)
        .setContentTitle("通知を受け取れていません")
        .setContentText("disnans を開くと、通知の受け取りを再開します")
        .setAutoCancel(true)
        .setContentIntent(pi)
        .build()
      try {
        context.getSystemService(NotificationManager::class.java).notify(ASK_OPEN_ID, n)
      } catch (ex: SecurityException) {
        DiagLog.w("[notify] 「アプリを開いて」の通知を出せませんでした", ex)
      }
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
  // 途中の経路で切れたことに気づけるよう、定期的に ping を送る（読み取りの時間切れは無し）
  private val client = ServerLink.socketClient(pingSeconds = 30, readTimeoutMs = 0L)
  /** 既読の位置を読む（普通の HTTP。WebSocket と違って時間で切る） */
  private val readClient = newReadMarkerClient()
  private var socket: WebSocket? = null
  private var attempt = 0
  private var stopped = false
  private val reconnect = Runnable { connect() }
  private var networkCallback: ConnectivityManager.NetworkCallback? = null
  /** つないでいる回線。切り替わったら、古い回線の socket は使えないので張り直す */
  private var currentNetwork: Network? = null
  /** 接続の持ち主（世代・アカウント・進行中の既読の同期）。メインのスレッドだけで触る */
  private val owner = SyncOwner()
  private lateinit var readSync: ReadSync

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    DiagLog.init(this)
    DiagLog.i("[notify] サービスを作りました")
    createChannels(this)
    startInForeground()
    running = true
    readSync = ReadSync(
      owner,
      OkReadMarkerSource(readClient),
      PrefsMarkers(Prefs(this)),
      AndroidNotes(this),
      { action -> handler.post { action() } },
      { DiagLog.i("[notify] $it") },
    )
    watchNetwork()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // サーバーの URL が変わったときにも呼ばれるので、つなぎ直す。intent が null なら、システムが作り直した（START_STICKY）
    DiagLog.i("[notify] onStartCommand restarted=${intent == null} flags=$flags")
    stopped = false
    attempt = 0
    socket?.cancel()
    socket = null
    connect()
    return START_STICKY
  }

  override fun onDestroy() {
    DiagLog.i("[notify] サービスを止めます（connected=$connected）")
    stopped = true
    owner.stop()
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

  /** 最近使ったアプリの一覧から消された。サービスはそのまま続く（機種によってはここで止められる） */
  override fun onTaskRemoved(rootIntent: Intent?) {
    DiagLog.i("[notify] アプリのタスクが消されました")
    super.onTaskRemoved(rootIntent)
  }

  private fun startInForeground() {
    val n = ongoingNotification()
    ForegroundSupport.startForeground(this, ONGOING_ID, n, Build.VERSION_CODES.UPSIDE_DOWN_CAKE, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
  }

  private fun ongoingNotification(): Notification =
    NotificationCompat.Builder(this, CHANNEL_CONNECTION)
      .setSmallIcon(R.drawable.disnans_notification)
      .setContentTitle(if (connected) "通知を受け取っています" else "サーバーに接続しています…")
      .setOngoing(true)
      .setShowWhen(false)
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .setContentIntent(openAppIntent(0))
      .build()

  private fun setConnected(value: Boolean) {
    if (connected == value) return
    connected = value
    DiagLog.i("[notify] ${if (value) "接続しました" else "切れました"}")
    if (running) getSystemService(NotificationManager::class.java).notify(ONGOING_ID, ongoingNotification())
  }

  /**
   * ネットワークが戻ったら、待たずにつなぎ直す。回線が切り替わった（Wi-Fi から携帯回線など）ときも、
   * 古い回線に残った socket は届かなくなるので、すぐ張り直す（気づくまで ping の時間ぶん通知が止まるのを防ぐ）。
   */
  private fun watchNetwork() {
    val cb = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        DiagLog.i("[notify] 回線が使えます: $network（いま: $currentNetwork connected=$connected）")
        handler.post {
          if (stopped) return@post
          if (connected && network == currentNetwork) return@post
          currentNetwork = network
          handler.removeCallbacks(reconnect)
          attempt = 0
          connect()
        }
      }

      override fun onLost(network: Network) {
        DiagLog.i("[notify] 回線を失いました: $network（いま: $currentNetwork）")
        handler.post {
          if (stopped || network != currentNetwork) return@post
          // この回線はもう使えない。つながっていないことを示し、次の回線が来たら（または backoff で）つなぎ直す
          currentNetwork = null
          owner.beginConnection()
          socket?.cancel()
          socket = null
          setConnected(false)
          scheduleReconnect()
        }
      }
    }
    try {
      getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(cb)
      networkCallback = cb
    } catch (ex: Exception) {
      DiagLog.w("[notify] ネットワークの監視を始められませんでした", ex)
    }
  }

  private fun connect() {
    handler.removeCallbacks(reconnect)
    if (stopped) return
    val base = Prefs(this).serverUrl
    if (base.isNullOrEmpty()) {
      DiagLog.w("[notify] サーバーの URL が無いので止めます")
      stopSelf()
      return
    }
    socket?.cancel()
    // 新しい接続の世代。前の接続の受信・既読の結果は、この世代では使わない
    val gen = owner.beginConnection()
    val request = try {
      Request.Builder().url(ServerLink.wsUrl(base)).build()
    } catch (ex: IllegalArgumentException) {
      DiagLog.w("[notify] サーバーの URL が不正です: $base", ex)
      stopSelf()
      return
    }
    DiagLog.i("[notify] つなぎます: ${request.url}")
    socket = client.newWebSocket(request, Listener(gen, base))
  }

  private fun scheduleReconnect() {
    if (stopped) return
    val delay = minOf(BACKOFF_MAX_MS, BACKOFF_BASE_MS shl minOf(attempt, 6))
    attempt++
    DiagLog.i("[notify] ${delay}ms 後につなぎ直します（${attempt} 回目）")
    handler.removeCallbacks(reconnect)
    handler.postDelayed(reconnect, delay)
  }

  /** この接続（世代）のまま、メインのスレッドで処理する。古い接続・停止後は何もしない */
  private fun onCurrent(gen: Long, webSocket: WebSocket, block: () -> Unit) {
    handler.post {
      if (webSocket !== socket || !owner.isCurrent(gen)) return@post
      block()
    }
  }

  private inner class Listener(private val gen: Long, private val base: String) : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
      onCurrent(gen, webSocket) {
        attempt = 0
        setConnected(true)
      }
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      // hello・read.updated は既読の同期へ、notify は表示へ（判断は NotifyPolicy・ReadSync）
      onCurrent(gen, webSocket) {
        handleServerText(text, gen, base, readSync, owner) {
          try {
            onNotify(JSONObject(text), gen)
          } catch (ex: Exception) {
            DiagLog.w("[notify] 通知の内容を読めませんでした")
          }
        }
      }
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
      DiagLog.i("[notify] サーバーが閉じました: code=$code reason=$reason")
      lost(webSocket)
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
      DiagLog.w("[notify] 接続に失敗しました（HTTP ${response?.code ?: "-"}）", t)
      lost(webSocket)
    }

    private fun lost(webSocket: WebSocket) {
      handler.post {
        if (webSocket !== socket) return@post
        // この接続の既読の同期と結果は、もう使わない（次の接続で読み直す）
        owner.beginConnection()
        socket = null
        setConnected(false)
        scheduleReconnect()
      }
    }
  }

  private fun onNotify(ev: JSONObject, gen: Long) {
    val sample = ev.optBoolean("sample", false)
    val logId = ev.optNullableString("message_id") ?: if (sample) "sample" else "-"
    // アプリが前面にあるときは、アプリ内の表示に任せる（サンプルは確認用なので必ず出す）
    if (!sample && isAppInForeground()) {
      DiagLog.i("[notify] 受信 $logId: アプリが前面なので出しません")
      return
    }

    val title = ev.optString("title")
    val body = ev.optString("body")
    val messageId = ev.optNullableString("message_id")
    // このアカウントの既読の位置（分からなければ、取り下げ・既読の判断の対象にならない別の値）
    val key = owner.accountFor(gen) ?: NotifyPolicy.UNKNOWN_ACCOUNT
    val prefs = Prefs(this)
    // 既読のメッセージ、接続が切れていた間の再送や二重に届いたものは、出さない
    if (!NotifyPolicy.shouldShow(messageId, prefs.lastRead(key), prefs.shownMessages)) {
      DiagLog.i("[notify] 既読か表示済みなので出しません")
      return
    }
    if (messageId != null) prefs.shownMessages = prefs.shownMessages + messageId
    val id = (messageId ?: "sample-${System.currentTimeMillis()}").hashCode()
    // タグにアカウントとメッセージ ID を入れる（再起動のあとでも、この通知だけを既読で取り下げられるように）
    val tag = messageId?.let { NotifyPolicy.messageTag(key, it) }

    val n = NotificationCompat.Builder(this, CHANNEL_MESSAGES)
      .setSmallIcon(R.drawable.disnans_notification)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setAutoCancel(true)
      .setContentIntent(openAppIntent(id))
      .build()
    try {
      val nm = getSystemService(NotificationManager::class.java)
      nm.notify(tag, id, n)
      DiagLog.i("[notify] 受信 $logId: 通知を出しました（許可=${nm.areNotificationsEnabled()}）")
    } catch (ex: SecurityException) {
      // 通知が許可されていない
      DiagLog.w("[notify] 受信 $logId: 通知を出せませんでした", ex)
    }
  }

  private fun openAppIntent(requestCode: Int): PendingIntent {
    val intent = (packageManager.getLaunchIntentForPackage(packageName) ?: Intent()).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      if (requestCode != 0) {
        putExtra(EXTRA_OPEN, true)
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

/** 既読の位置の保存（Prefs）を、同期の口へ */
private class PrefsMarkers(private val prefs: Prefs) : MarkerStore {
  override fun lastRead(account: String): String? = prefs.lastRead(account)
  override fun setLastRead(account: String, messageId: String) = prefs.setLastRead(account, messageId)
}

/** 表示中の通知（NotificationManager）を、同期の口へ。取得できなければ何もない扱い */
private class AndroidNotes(context: Context) : NoteStore {
  private val nm = context.getSystemService(NotificationManager::class.java)
  override fun active(): List<NotifyPolicy.ActiveNote> = try {
    nm.activeNotifications.map { NotifyPolicy.ActiveNote(it.tag, it.id) }
  } catch (ex: SecurityException) {
    emptyList()
  }
  override fun cancel(tag: String?, id: Int) {
    try {
      nm.cancel(tag, id)
    } catch (ex: SecurityException) {
      DiagLog.w("[notify] 通知を取り下げられませんでした")
    }
  }
}
