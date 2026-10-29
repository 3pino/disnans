package dev.disnans.notifier

import android.Manifest
import android.app.ActivityManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import com.fasterxml.jackson.databind.ObjectMapper
import okhttp3.OkHttpClient
import java.security.SecureRandom
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * ネイティブの通話の入口（プラグイン・サービス・通知から使う）。実行の中心は [NativeCallRuntime]（純粋な JVM）。
 * ここでは、デバイスの資源（OkHttp・AudioRecord・経路・サービス・保存・タイマー）を、その実装へつなぐだけ。
 *
 * 規則:
 * - 状態機械と保存と通信の応答は、制御のスレッド（1 本）でだけ動く。
 * - 録音の開始・経路・前景の通知の更新は io のスレッド（1 本）。UI のスレッドでは、録音を開かない。
 * - 呼び出し（prepare・stop など）は、制御のスレッドの結果を待つ（上限つき）。準備は資源を動かさない。
 * - 外への通知（[addListener]）は、別のスレッドで順番どおりに届く。
 * - ログには番号・音の数・固定のコードだけを書く（音・ID・URL・認証の情報は書かない）。
 */
object NativeCallHost {
  private val rng = SecureRandom()
  private val mapper = ObjectMapper()
  private val listeners = CopyOnWriteArrayList<(NativeCallEvent) -> Unit>()

  private val control: ExecutorService by lazy { single("disnans-native-control") }
  private val io: ExecutorService by lazy { single("disnans-native-io") }
  private val events: ExecutorService by lazy { single("disnans-native-events") }
  private val timers: ScheduledExecutorService by lazy {
    Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "disnans-native-timers").apply { isDaemon = true } }
  }
  private val client: OkHttpClient by lazy {
    OkHttpClient.Builder()
      .connectTimeout(10, TimeUnit.SECONDS)
      .pingInterval(20, TimeUnit.SECONDS)
      .build()
  }

  private var runtime: NativeCallRuntime? = null

  private fun single(name: String): ExecutorService =
    Executors.newSingleThreadExecutor { r -> Thread(r, name).apply { isDaemon = true } }

  /** 実行の中心を、最初の呼び出しで作る（以後は同じもの） */
  private fun rt(context: Context): NativeCallRuntime = synchronized(this) {
    runtime?.let { return it }
    val c = context.applicationContext
    val r = NativeCallRuntime(
      store = NativeCallPrefs(c),
      sockets = AndroidSocketFactory(client),
      audio = AndroidAudioFactory,
      route = AndroidRoute(c),
      service = AndroidService(c),
      timers = AndroidTimers(timers),
      control = control,
      io = io,
      publish = { e -> events.execute { for (l in listeners) runCatching { l(e) } } },
      log = AndroidLog,
      peerFactory = ::randomPeer,
    )
    runtime = r
    r
  }

  // ---- 公開の入口（プラグインから） ----

  /** 開始の準備。通話の ID を先に登録する（権限の確認より前）。他の通話があれば false。資源は動かさない */
  fun prepare(context: Context, session: String, start: NativeCallStartArgs): Boolean =
    attempt(false) { if (start.session == session) rt(context).prepare(start).ok else false }

  /** 権限が許されたあと、準備した通話だけを始める */
  fun startPrepared(context: Context, session: String): Boolean =
    attempt(false) { rt(context).startPrepared(session).ok }

  /** 準備中・開始中の通話をやめる（何度呼んでもよい） */
  fun cancelPrepared(context: Context, session: String, reason: String) {
    attempt(Unit) { rt(context).cancelPrepared(session, reason) }
  }

  /**
   * 明示の停止。戻るのは、保存（wanted=false）が済んでから（ACK）。時間内に終わらなければ false。
   * 古い通話の ID では効かない。
   */
  fun stop(context: Context, session: String, reason: String): Boolean =
    attempt(false) { rt(context).stop(session, reason) }

  /** 現在の状態（読み取りだけ。何も始めない）。通話が無いときは、保存されている wanted を返す */
  fun snapshot(context: Context): NativeCallSnapshot? = attempt(null) { rt(context).snapshot() }

  /** ミュート・スピーカーミュート・相手ごとの消音・音の設定（部分の変更） */
  fun control(context: Context, session: String, patch: NativeCallControlPatch): Outcome =
    attempt(Outcome(false, "failed")) { rt(context).control(session, patch) }

  /** 相手の接続を外す（キック） */
  fun kick(context: Context, session: String, peer: String): Outcome =
    attempt(Outcome(false, "failed")) { rt(context).kick(session, peer) }

  /** 音以外の通話のイベント（プラグイン用）。payloadJson は JSON の値のテキスト */
  fun emit(context: Context, session: String, name: String, payloadJson: String): Outcome {
    val node = try {
      mapper.readTree(payloadJson)
    } catch (_: Exception) {
      return Outcome(false, "bad_payload")
    }
    return attempt(Outcome(false, "failed")) { rt(context).emit(session, name, node) }
  }

  /** 状態と中継のイベントを受け取る。戻り値の関数で外せる。届くのは別のスレッド */
  fun addListener(listener: (NativeCallEvent) -> Unit): () -> Unit {
    listeners.add(listener)
    return { listeners.remove(listener) }
  }

  /** 出力先を選んだとき（通話が無いときは設定として残す。通話中なら通話にも効かせる） */
  fun noteOutputSelection(context: Context, outputId: String?) {
    attempt(Unit) { rt(context).outputSelected(outputId) }
  }

  /**
   * WebView が起動したとき（プラグインの読み込み）。保存された wanted を消してよいのは、
   * 強制終了の証拠があるとき（API 30 以上の終了の理由）か、API 29 以前でエンジンが動いていないとき。
   * ここではサービスを始めない。
   */
  fun onUiLaunch(context: Context): Boolean =
    attempt(false) { rt(context).uiLaunch(Build.VERSION.SDK_INT, lastExitReason(context)) }

  // ---- サービス（NativeCallService）から ----

  /** システムの再起動（intent が null）。保存された wanted のときだけ再開する。戻り値は再開を始めたか */
  fun adoptFromRestart(context: Context): Boolean {
    val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    return attempt(false) { rt(context).adopt(granted) }
  }

  /** サービスが前景になるとき。その番号を返す（壊されたときに、自分の通話かどうかの確かめに使う） */
  fun servicePromoted(context: Context, session: String): Long = attempt(0L) { rt(context).servicePromoted(session) }

  /** 前景にできたかどうか（開始の命令への応答） */
  fun serviceStarted(context: Context, session: String, ok: Boolean) {
    attempt(Unit) { rt(context).serviceStarted(session, ok) }
  }

  /** サービスが壊された。自分の番号のときだけ、その通話を止める */
  fun serviceDestroyed(context: Context, run: Long) {
    attempt(Unit) { rt(context).serviceDestroyed(run) }
  }

  /** 通知のボタン（通知の意図の通話の ID で、古いものを除く） */
  fun notificationAction(context: Context, action: NotificationAction?, session: String?): NotificationDecision {
    val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    return attempt(NotificationDecision(false, null, false, stopService = true)) {
      rt(context).notificationAction(action, session, granted)
    }
  }

  // ---- デバイスの資源への接続（ポート） ----

  @RequiresApi(30)
  private fun exitReason30(context: Context): Int? = try {
    context.getSystemService(ActivityManager::class.java)
      .getHistoricalProcessExitReasons(context.packageName, 0, 1)
      .firstOrNull()?.reason
  } catch (_: Exception) {
    null
  }

  private fun lastExitReason(context: Context): Int? =
    if (Build.VERSION.SDK_INT >= NativeCallRecovery.SDK_EXIT_INFO) exitReason30(context) else null

  private fun randomPeer(): String {
    val b = ByteArray(6)
    rng.nextBytes(b)
    return b.joinToString("") { "%02x".format(it.toInt() and 0xff) }
  }

  /** 実行の中心の呼び出しを、上限つきで。失敗は既定の値を返し、固定の文言だけを記録する */
  private inline fun <T> attempt(default: T, block: () -> T): T = try {
    block()
  } catch (e: Exception) {
    DiagLog.w("[native-call] 処理を完了できませんでした（${e.javaClass.simpleName}）")
    default
  }
}

/** 通信の 1 回の接続（[CallSocket]）。試みごとに作る */
internal class AndroidSocketFactory(private val client: OkHttpClient) : CallSocketFactory {
  override fun create(listener: CallSocketListener): CallSocket {
    val wire = NativeCallWire(client, object : NativeCallWireListener {
      override fun onOpen() {
        // 挨拶（hello）を待つ
      }

      override fun onFrame(frame: ServerFrame) {
        listener.onFrame(frame)
      }

      override fun onClosed(failure: WireFailure, httpStatus: Int?) {
        listener.onClosed(reasonOf(failure, httpStatus))
      }
    })
    return WireSocket(wire)
  }

  private fun reasonOf(failure: WireFailure, httpStatus: Int?): String = when (failure) {
    WireFailure.HTTP_REJECTED -> if (httpStatus == 401 || httpStatus == 403) "auth_rejected" else "http_rejected"
    WireFailure.CONNECT_FAILED -> "connect_failed"
    WireFailure.PROTOCOL -> "protocol"
    WireFailure.OVERFLOW -> "overflow"
    WireFailure.REMOTE_CLOSED -> "remote_closed"
    WireFailure.FAILED -> "socket_failed"
  }
}

private class WireSocket(private val wire: NativeCallWire) : CallSocket {
  override fun connect(serverUrl: String, devUser: String?) = wire.connect(serverUrl, devUser)
  override fun sendControl(text: String): Boolean = wire.sendControl(text) == NativeCallWire.SendResult.SENT
  override fun sendAudio(text: String): Boolean = wire.sendAudio(text) == NativeCallWire.SendResult.SENT
  override fun queuedBytes(): Long = wire.queuedBytes
  override fun close() = wire.close()
  override fun cancel() = wire.cancel()
}

private class AndroidRoute(private val c: Context) : RoutePort {
  override fun begin() = CallAudio.begin(c, RouteOwner.NATIVE)
  override fun end() = CallAudio.end(c, RouteOwner.NATIVE)
  override fun select(outputId: String): Boolean = CallAudio.set(c, outputId)
}

private class AndroidService(private val c: Context) : ServicePort {
  override fun start(session: String): Boolean = NativeCallService.start(c, session)
  override fun stop() = NativeCallService.requestStop(c)
  override fun isRunning(): Boolean = NativeCallService.running
  override fun refresh(snapshot: NativeCallSnapshot) = NativeCallService.refreshNotification(c, snapshot)
}

private class AndroidTimers(private val exec: ScheduledExecutorService) : TimerPort {
  override fun schedule(delayMs: Long, task: Runnable): () -> Unit {
    val f = exec.schedule(task, delayMs, TimeUnit.MILLISECONDS)
    return { f.cancel(false) }
  }
}

private object AndroidLog : RuntimeLog {
  override fun info(message: String) = DiagLog.i(message)
  override fun warn(message: String) = DiagLog.w(message)
}
