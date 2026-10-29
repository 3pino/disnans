package dev.disnans.notifier

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * ネイティブの通話のフォアグラウンドサービス（microphone 型）。WebView や Tauri とは別に、同じプロセスで動く。
 * 通知は ID 3（既存の CallService の ID 2 とは別）。ボタンの意図には、通話の ID を入れる（古い通知は効かない）。
 *
 * - 開始（ACTION_START）: ユーザーの開始、または実行の中心が求めたときだけ。前景にして、結果を報告する。
 * - 再起動（intent が null）: 保存された wanted を見て、実行の中心が決める。再開しないなら NOT_STICKY で止まる。
 * - 通知のボタン: 実行の中心が、今の通話か保存された通話かを確かめてから効かせる。音声は始めない。
 * - 壊されたとき: 自分の番号（run）の通話だけを止める（新しい通話は止めない）。
 * CPU の保持（部分的な wake lock）は 8 時間で切れるため、切れる前に取り直す（通話の期限ではない）。
 */
class NativeCallService : Service() {
  companion object {
    const val NOTIFICATION_ID = 3
    private const val CHANNEL = "call"
    private const val TAG_LOCK = "disnans:nativecall"
    private const val EXTRA_SESSION = "session"
    private const val SCHEME = "disnans-native-call"

    const val ACTION_START = "dev.disnans.notifier.NATIVE_CALL_START"
    const val ACTION_MUTE = "dev.disnans.notifier.NATIVE_CALL_MUTE"
    const val ACTION_DEAFEN = "dev.disnans.notifier.NATIVE_CALL_DEAFEN"
    const val ACTION_HANGUP = "dev.disnans.notifier.NATIVE_CALL_HANGUP"

    /** wake lock の 1 回の長さと、取り直す間隔（上限の 8 時間より前） */
    private const val LOCK_MS = 6L * 60 * 60 * 1000
    /** 期限の前に延長する時間（ロックが切れてから取り直すことにならないように） */
    private const val RENEW_BEFORE_MS = 60L * 60 * 1000
    private const val RENEW_MS = 5L * 60 * 60 * 1000

    /**
     * 再起動・通知の処理は、ここで行う（保存の読み書きを主スレッドで待たない）。
     * 開始（ACTION_START）だけは、前景にするため主スレッドで速く返す。
     */
    private val worker: java.util.concurrent.ExecutorService by lazy {
      java.util.concurrent.Executors.newSingleThreadExecutor { r -> Thread(r, "disnans-native-service").apply { isDaemon = true } }
    }

    /** 動いているかどうか（サービスが作られてから壊されるまで） */
    @Volatile var running = false
      private set

    /** 通話が前景で動いているときの通知（無ければ通話は動いていない）。古い開始の命令が、これを壊さないために使う */
    @Volatile private var liveNotification: Notification? = null

    /** 開始を頼む。startForegroundService が拒否されたら false */
    fun start(context: Context, session: String): Boolean {
      val intent = Intent(context, NativeCallService::class.java)
        .setAction(ACTION_START)
        .putExtra(EXTRA_SESSION, session)
      return try {
        ContextCompat.startForegroundService(context, intent)
        true
      } catch (_: Exception) {
        false
      }
    }

    /** 止める（動いていなければ何もしない） */
    fun requestStop(context: Context) {
      context.stopService(Intent(context, NativeCallService::class.java))
    }

    /** 通知の文言を今の状態に合わせる（動いているときだけ） */
    fun refreshNotification(context: Context, s: NativeCallSnapshot) {
      if (!running) return
      val session = s.session ?: return
      val nm = context.getSystemService(NotificationManager::class.java) ?: return
      val n = build(context, s, session)
      liveNotification = n
      nm.notify(NOTIFICATION_ID, n)
    }

    /** 通話の停止（サービスが壊されたとき） */
    internal fun clearLive() {
      liveNotification = null
    }

    /** 前景の通知の中身（古い開始の命令のとき、通話の通知を壊さずに前景を満たすため） */
    internal fun currentOrPlaceholder(context: Context): Notification {
      liveNotification?.let { return it }
      createChannel(context)
      return NotificationCompat.Builder(context, CHANNEL)
        .setSmallIcon(R.drawable.disnans_notification)
        .setContentTitle("通話")
        .setContentText("準備しています")
        .setOngoing(true)
        .build()
    }

    /** 通知のボタンの意図（通話の ID を、データとして入れる。ボタンごと・通話ごとに別の意図になる） */
    private fun actionIntent(context: Context, action: String, session: String, code: Int): PendingIntent {
      val i = Intent(context, NativeCallService::class.java)
        .setAction(action)
        .putExtra(EXTRA_SESSION, session)
        .setData(Uri.parse("$SCHEME://$action/$session"))
      return PendingIntent.getService(context, code, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun build(context: Context, s: NativeCallSnapshot, session: String): Notification {
      createChannel(context)
      val open = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      } ?: Intent()
      val contentIntent = PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      val states = arrayListOf(if (s.muted) "ミュート中" else "通話中")
      if (s.deafened) states.add("スピーカーミュート中")
      val count = s.members.size
      val text = if (count > 0) "${states.joinToString("・")} ・ ${count}人" else states.joinToString("・")
      val builder = NotificationCompat.Builder(context, CHANNEL)
        .setSmallIcon(R.drawable.disnans_notification)
        .setContentTitle("通話")
        .setContentText(text)
        .setOngoing(true)
        .setShowWhen(false)
        .setCategory(NotificationCompat.CATEGORY_CALL)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .setContentIntent(contentIntent)
      builder.addAction(0, if (s.muted) "ミュート解除" else "ミュート", actionIntent(context, ACTION_MUTE, session, 101))
      builder.addAction(0, if (s.deafened) "スピーカー解除" else "スピーカーミュート", actionIntent(context, ACTION_DEAFEN, session, 102))
      builder.addAction(0, "切断", actionIntent(context, ACTION_HANGUP, session, 103))
      return builder.build()
    }

    private fun createChannel(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      context.getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(CHANNEL, "通話", NotificationManager.IMPORTANCE_LOW).apply {
          description = "通話中であることを示す"
          setShowBadge(false)
        },
      )
    }
  }

  private var wakeLock: PowerManager.WakeLock? = null
  private val handler = Handler(Looper.getMainLooper())
  private val renew = Runnable { holdWakeLock() }
  /** このサービスの番号（前景になったときに実行の中心が決める）。壊されたときに、自分の通話かを確かめる */
  private var serviceRun = 0L
  /** この通話を前景にした開始の番号（その開始に限って止めるため） */
  private var promotedStartId = -1

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    DiagLog.init(this)
    running = true
    DiagLog.i("[native-call] サービスを作りました")
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val app = applicationContext
    val action = intent?.action
    // システムの再起動（intent が null）: 開始はしない。保存された wanted を見て、実行の中心が決める（作業スレッドで）。
    // 再開しないときだけ止める。戻り値は STICKY（再開できる印を保つ）
    if (action == null) {
      worker.execute {
        // この開始の番号で止める（新しい開始が受けられていれば、止めない）
        if (!NativeCallHost.adoptFromRestart(app)) stopSelf(startId)
      }
      return START_STICKY
    }
    return when (action) {
      ACTION_START -> {
        val session = intent?.getStringExtra(EXTRA_SESSION)
        if (session.isNullOrEmpty()) return quit(startId)
        // 開始を待っている通話だけを前景にする。古い開始の命令は、前景を作らずに片付ける
        val run = NativeCallHost.servicePromoted(app, session)
        if (run == 0L) return staleStart(startId)
        serviceRun = run
        promotedStartId = startId
        promote(session)
        START_STICKY
      }
      ACTION_MUTE, ACTION_DEAFEN, ACTION_HANGUP -> {
        val session = intent?.getStringExtra(EXTRA_SESSION)
        val notified = actionOf(action)
        // 通話が続くあいだの操作は STICKY のまま（最後の戻り値が、再起動の扱いを決める）。切断と無効な意図は止まる
        val live = NativeCallService.liveNotification != null
        val keep = NativeCallSticky.keepAfter(notified, isNullIntent = false, liveCallRemains = live)
        worker.execute {
          val decision = NativeCallHost.notificationAction(app, notified, session)
          if (decision.stopService) stopSelf(startId)
        }
        if (keep) START_STICKY else START_NOT_STICKY
      }
      else -> quit(startId)
    }
  }

  /**
   * 開始を待っていない通話の開始の命令（遅れて届いたもの）。
   * 生きている通話があれば、その前景をそのまま再掲して残す（止めない・作り直さない）。
   * 無ければ、開始の期限を満たすために前景を一瞬だけ作って外し、この開始の番号で止める。
   */
  private fun staleStart(startId: Int): Int {
    val live = NativeCallService.liveNotification
    if (live != null) {
      try {
        startForeground(NOTIFICATION_ID, live)
      } catch (_: Exception) {
        DiagLog.w("[native-call] 古い開始の命令で、前景を再掲できませんでした")
      }
      return if (NativeCallSticky.staleStartKeeps(liveCallRemains = true)) START_STICKY else START_NOT_STICKY
    }
    try {
      startForeground(NOTIFICATION_ID, NativeCallService.currentOrPlaceholder(applicationContext))
    } catch (_: Exception) {
      DiagLog.w("[native-call] 古い開始の命令を片付けられませんでした")
    }
    try {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } catch (_: Exception) {
    }
    stopSelf(startId)
    return START_NOT_STICKY
  }

  private fun actionOf(action: String): NotificationAction? = when (action) {
    ACTION_MUTE -> NotificationAction.MUTE
    ACTION_DEAFEN -> NotificationAction.DEAFEN
    ACTION_HANGUP -> NotificationAction.HANGUP
    else -> null
  }

  /** 止めて、戻らない（NOT_STICKY） */
  private fun quit(startId: Int): Int {
    stopSelf(startId)
    return START_NOT_STICKY
  }

  /** 前景にする（開始の命令への応答）。失敗は、開始の失敗として実行の中心へ */
  private fun promote(session: String) {
    val app = applicationContext
    val n = build(app, NativeCallSnapshot(
      session = session, generation = 0, seq = 0, wanted = false, phase = NativeCallPhase.JOINING,
      serverUrl = null, peer = null, members = emptyList(), muted = false, deafened = false, muteByDeafen = false,
      speaking = emptyMap(), localMuted = emptyList(), settings = NativeCallSettings(1.0, 1.0, true, NativePcm.LIMIT_DB_DEFAULT, false, null),
      linkUp = false, listed = false, bufferedBytes = 0L, error = null,
    ), session)
    val ok = try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
      } else {
        startForeground(NOTIFICATION_ID, n)
      }
      true
    } catch (e: Exception) {
      DiagLog.w("[native-call] 前景にできませんでした（${e.javaClass.simpleName}）")
      false
    }
    if (ok) {
      holdWakeLock()
      NativeCallService.liveNotification = n
    }
    NativeCallHost.serviceStarted(app, session, ok)
    // 失敗したのは、この通話を前景にした開始。その開始の番号で止める（新しい開始を止めない）
    if (!ok) stopSelf(promotedStartId)
  }

  /**
   * 起動の保持。取得に失敗したら、既に持っているロックは捨てない（そのまま保持する）。
   * 例外は外に出さず、固定の診断だけを残す（生の例外文は出さない）。
   */
  private fun holdWakeLock() {
    val pm = try {
      getSystemService(PowerManager::class.java)
    } catch (_: Exception) {
      null
    } ?: return diagWake("電源の管理を取得できませんでした")
    val lock = try {
      pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, TAG_LOCK).apply { setReferenceCounted(false) }
    } catch (_: Exception) {
      return diagWake("起動の保持を作れませんでした")
    }
    try {
      lock.acquire(LOCK_MS)
    } catch (_: Exception) {
      // 取得できなかった: 既存のロックはそのまま（失わない）
      return diagWake("起動の保持を取得できませんでした")
    }
    val old = wakeLock
    wakeLock = lock
    if (old != null) safeRelease(old)
    handler.removeCallbacks(renew)
    handler.postDelayed(renew, LOCK_MS - RENEW_BEFORE_MS)
  }

  private fun releaseWakeLock() {
    handler.removeCallbacks(renew)
    wakeLock?.let { safeRelease(it) }
    wakeLock = null
  }

  private fun safeRelease(lock: PowerManager.WakeLock) {
    try {
      if (lock.isHeld) lock.release()
    } catch (_: Exception) {
      diagWake("起動の保持を外せませんでした")
    }
  }

  private fun diagWake(message: String) {
    DiagLog.w("[native-call] $message")
  }

  override fun onDestroy() {
    running = false
    NativeCallService.clearLive()
    releaseWakeLock()
    // 自分の番号の通話だけを止める（新しい通話は、この停止の後に始まっているかもしれない）
    NativeCallHost.serviceDestroyed(applicationContext, serviceRun)
    serviceRun = 0L
    try {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } catch (_: Exception) {
      // 前景でなかった
    }
    super.onDestroy()
  }
}
