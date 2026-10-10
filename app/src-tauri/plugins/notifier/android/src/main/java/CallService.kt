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
import android.net.Uri
import android.os.IBinder
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentLinkedQueue
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * 通話など、画面を消してもマイクを使い続けるためのフォアグラウンドサービス（microphone 型）。
 * 中身は何もしない。サービスが動いている間、プロセスと WebView（WebRTC）が止められにくくなる。
 * マイクの許可（RECORD_AUDIO）を得たあと、アプリが前面にあるときに始めること（Android 14 以降の決まり）。
 *
 * 通知にはアクションボタンを付けられる（ミュート・切断など）。押されたら [actionSink] で JS（プラグイン）に届ける。
 * 届けられないとき（WebView が止まっている・アプリのプロセスが作り直された）は [pendingActions] に溜め、
 * `dismiss` つきのボタンなら、JS を待たずにここで通知とサービスを止める（切断が必ず効くように）。
 * 同じ start を呼び直すと、通知の文言とボタンだけが差し替わる。
 */
/** 通知のボタン。dismiss が true なら、JS に届かなくても通知とサービスを止める */
data class CallButton(val id: String, val title: String, val dismiss: Boolean)

class CallService : Service() {
  companion object {
    private const val CHANNEL_CALL = "call"
    private const val ONGOING_ID = 2
    private const val EXTRA_TITLE = "title"
    private const val EXTRA_TEXT = "text"
    private const val EXTRA_MICROPHONE = "microphone"
    private const val EXTRA_ACTIONS = "actions"
    private const val EXTRA_ACTION_ID = "action_id"
    private const val ACTION_BUTTON = "dev.disnans.notifier.CALL_ACTION"
    private const val MAX_ACTIONS = 3
    private const val MAX_PENDING = 20

    /** ボタンが押されたときの届け先（プラグインが入れる）。届けたら true */
    @Volatile var actionSink: ((String) -> Boolean)? = null

    /** 届けられなかったボタン。JS が準備できたら受け取る */
    val pendingActions = ConcurrentLinkedQueue<String>()

    /** 直近の start で渡されたボタン（dismiss の判定に使う） */
    @Volatile private var buttons: List<CallButton> = emptyList()

    @Volatile var running = false
      private set

    fun start(context: Context, title: String, text: String, microphone: Boolean, actions: List<CallButton> = emptyList()) {
      val json = JSONArray()
      for (a in actions.take(MAX_ACTIONS)) {
        json.put(JSONObject().put("id", a.id).put("title", a.title).put("dismiss", a.dismiss))
      }
      val intent = Intent(context, CallService::class.java)
        .putExtra(EXTRA_TITLE, title)
        .putExtra(EXTRA_TEXT, text)
        .putExtra(EXTRA_MICROPHONE, microphone)
        .putExtra(EXTRA_ACTIONS, json.toString())
      ContextCompat.startForegroundService(context, intent)
    }

    fun stop(context: Context) {
      pendingActions.clear()
      context.stopService(Intent(context, CallService::class.java))
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_BUTTON) {
      onCallButton(intent.getStringExtra(EXTRA_ACTION_ID).orEmpty())
      return START_NOT_STICKY
    }
    val title = intent?.getStringExtra(EXTRA_TITLE).orEmpty().ifEmpty { "通話" }
    val text = intent?.getStringExtra(EXTRA_TEXT).orEmpty()
    val microphone = intent?.getBooleanExtra(EXTRA_MICROPHONE, true) ?: true
    createChannel(this)
    val list = parseButtons(intent?.getStringExtra(EXTRA_ACTIONS))
    buttons = list
    val n = notification(title, text, list)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val type = if (microphone) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
      startForeground(ONGOING_ID, n, type)
    } else {
      startForeground(ONGOING_ID, n)
    }
    if (!running && microphone) CallAudio.begin(this)
    running = true
    // 強制終了されたあとに勝手に再開しない（マイクの許可や前面の条件を満たせないため）
    return START_NOT_STICKY
  }

  private fun onCallButton(id: String) {
    // 通話が終わったあとのボタン（古い通知）や、サービスが作り直されただけの場合は何もしない
    if (!running || id.isEmpty()) {
      if (!running) stopSelf()
      return
    }
    val delivered = try {
      actionSink?.invoke(id) == true
    } catch (e: Exception) {
      false
    }
    if (delivered) return
    if (pendingActions.size < MAX_PENDING) pendingActions.add(id)
    if (buttons.any { it.id == id && it.dismiss }) {
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
    }
  }

  private fun parseButtons(raw: String?): List<CallButton> {
    if (raw.isNullOrEmpty()) return emptyList()
    return try {
      val arr = JSONArray(raw)
      (0 until arr.length()).mapNotNull { i ->
        val o = arr.optJSONObject(i) ?: return@mapNotNull null
        val id = o.optString("id")
        if (id.isEmpty()) null else CallButton(id, o.optString("title", id), o.optBoolean("dismiss", false))
      }
    } catch (e: Exception) {
      emptyList()
    }
  }

  override fun onDestroy() {
    if (running) CallAudio.end(this)
    running = false
    super.onDestroy()
  }

  private fun notification(title: String, text: String, actions: List<CallButton>): Notification {
    val open = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    } ?: Intent()
    val pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val builder = NotificationCompat.Builder(this, CHANNEL_CALL)
      .setSmallIcon(R.drawable.disnans_notification)
      .setContentTitle(title)
      .setContentText(text)
      .setOngoing(true)
      .setShowWhen(false)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setContentIntent(pi)
    for ((i, a) in actions.withIndex()) {
      // data を変えて、ボタンごとに別の PendingIntent にする
      val intent = Intent(this, CallService::class.java)
        .setAction(ACTION_BUTTON)
        .setData(Uri.parse("disnans-call://action/${Uri.encode(a.id)}"))
        .putExtra(EXTRA_ACTION_ID, a.id)
      val api = PendingIntent.getService(this, 100 + i, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      builder.addAction(0, a.title, api)
    }
    return builder.build()
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
