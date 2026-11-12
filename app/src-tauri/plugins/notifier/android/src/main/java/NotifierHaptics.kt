package dev.disnans.notifier

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioManager
import android.os.Build
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.core.content.ContextCompat
import app.tauri.plugin.Invoke

/** 操作の振動（タッチの合図）と、WebView の標準の振動の設定。鳴らしてよいかは HapticsPolicy が決める */
internal class NotifierHaptics(private val bridge: NotifierBridge) {
  private val activity get() = bridge.activity
  private val prefs get() = bridge.prefs

  /**
   * 操作の合図の振動（タッチ）。WebView の navigator.vibrate は長押し中（user activation が無い）に拒否されるため、ネイティブで鳴らす。
   * 鳴らしてよいかは HapticsPolicy が決める（アプリの設定・サイレント・集中モード。デバイスのタッチ設定は読まない）。
   * 鳴らさないときと振動器が無いときは何もせず resolve。失敗は固定の語で reject（例外の中身は渡さない）。通知の振動は扱わない。
   */
  fun vibrate(invoke: Invoke) {
    val args = invoke.parseArgs(VibrateArgs::class.java)
    try {
      val ms = HapticsPolicy.clampMs(args.ms)
      val vibrator = vibratorOrNull()
      val appEnabled = prefs.hapticsEnabled && HapticsPolicy.appFlagFrom(args.enabled)
      val snapshot = HapticsPolicy.Snapshot(
        appEnabled = appEnabled,
        ringer = currentRinger(),
        dnd = currentDnd(),
        hasVibrator = vibrator != null,
      )
      if (HapticsPolicy.decide(snapshot) == HapticsPolicy.Decision.Vibrate && vibrator != null) {
        vibrateOnce(vibrator, ms)
      }
      invoke.resolve()
    } catch (ex: Exception) {
      DiagLog.w("[haptics] vibrate failed")
      invoke.reject("vibrate_failed")
    }
  }

  /**
   * 操作の振動のアプリの設定（JS の設定・起動時の同期から送る）。WebView の標準の振動（長押しなど）にも効く。
   * 保存してから、WebView へ反映し終えたあとで resolve する（JS は反映の後に次の設定を送る）。省けば有効。
   * WebView がまだ無いときは保存だけして resolve（次に画面を開いたときの反映で効く）。反映に失敗したら固定の語で reject。
   */
  fun setEnabled(invoke: Invoke) {
    val args = invoke.parseArgs(SetHapticsArgs::class.java)
    prefs.hapticsEnabled = HapticsPolicy.appFlagFrom(args.enabled)
    applyToWebView { ok ->
      if (ok) invoke.resolve() else invoke.reject("haptics_apply_failed")
    }
  }

  private fun vibratorOrNull(): Vibrator? {
    val vibrator: Vibrator? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      (activity.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
    } else {
      @Suppress("DEPRECATION")
      activity.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
    }
    return vibrator?.takeIf { it.hasVibrator() }
  }

  /** 着信音のモード（読めなければ UNKNOWN＝鳴らさない側） */
  private fun currentRinger(): HapticsPolicy.Ringer = try {
    HapticsPolicy.ringerOf((activity.getSystemService(Context.AUDIO_SERVICE) as? AudioManager)?.ringerMode)
  } catch (ex: Exception) {
    HapticsPolicy.Ringer.UNKNOWN
  }

  /** 集中モード（読めなければ UNKNOWN＝鳴らさない側） */
  private fun currentDnd(): HapticsPolicy.Dnd = try {
    HapticsPolicy.dndOf(activity.getSystemService(NotificationManager::class.java)?.currentInterruptionFilter)
  } catch (ex: Exception) {
    HapticsPolicy.Dnd.UNKNOWN
  }

  /**
   * WebView の標準の振動（長押しなど）を、今の判断に合わせる。
   * 判断（設定・着信音・集中モード）は、UI のスレッドで反映するときに読む（投げる前の古い値を使わない）。
   * 永久に止めるのではなく、設定・着信音・集中モードが変わるたびに決め直す（許可に戻れば、また鳴る）。
   * [onDone] は反映のあと（UI のスレッド）に 1 度だけ呼ぶ。true は反映できた（または WebView が無い）、false は失敗。
   */
  fun applyToWebView(onDone: (Boolean) -> Unit = {}) {
    val view = bridge.webView
    if (view == null) {
      onDone(true)
      return
    }
    val posted = view.post {
      val ok = try {
        view.isHapticFeedbackEnabled = HapticsPolicy.allowed(prefs.hapticsEnabled, currentRinger(), currentDnd())
        true
      } catch (ex: Exception) {
        DiagLog.w("[haptics] apply failed")
        false
      }
      onDone(ok)
    }
    // 投げられなかった（画面が無い）ときも、待たせない
    if (!posted) onDone(false)
  }

  /** 前面にいるあいだだけ、着信音・集中モードの変化を受けて WebView の振動を決め直す */
  private val receiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      applyToWebView()
    }
  }
  private var receiverOn = false

  fun watch() {
    if (receiverOn) return
    try {
      val filter = IntentFilter().apply {
        addAction(AudioManager.RINGER_MODE_CHANGED_ACTION)
        addAction(NotificationManager.ACTION_INTERRUPTION_FILTER_CHANGED)
      }
      // デバイスの状態の変化（システムの放送）だけを受ける。外からは受けない
      ContextCompat.registerReceiver(activity, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
      receiverOn = true
    } catch (ex: Exception) {
      DiagLog.w("[haptics] watch failed")
    }
  }

  fun unwatch() {
    if (!receiverOn) return
    receiverOn = false
    try {
      activity.unregisterReceiver(receiver)
    } catch (ex: IllegalArgumentException) {
      // すでに外れている
    }
  }

  private fun vibrateOnce(vibrator: Vibrator, ms: Long) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      // タッチ操作として鳴らす（通知・通話・アラームの用途にはしない）
      val effect = VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE)
      vibrator.vibrate(effect, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_TOUCH))
    } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      // Android 8〜12: 用途の指定は AudioAttributes。タッチの合図に近い「操作の音（ソニフィケーション）」にする（通知・通話・アラームにはしない）
      val attributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build()
      vibrator.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE), attributes)
    } else {
      // Android 7 以前（minSdk は 24）。VibrationEffect は 26 から
      @Suppress("DEPRECATION")
      vibrator.vibrate(ms)
    }
  }
}
