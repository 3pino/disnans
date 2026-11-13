package dev.disnans.notifier

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.os.Build
import android.os.PowerManager

/**
 * 前景サービスの共通の部分（通知のチャンネル・前景への昇格・起動の保持の作成）。
 * 各サービスの判断（いつ始めるか・失敗のあつかい・再取得の方法）は、それぞれのサービスが持つ。
 */
internal object ForegroundSupport {
  /** 通話の通知のチャンネル。通話（CallService）と、ネイティブの通話（NativeCallService）が同じものを使う */
  const val CALL_CHANNEL = "call"

  /**
   * 前景の種類を渡せる API の段（[minSdk] 以上）なら [type]、低ければ null（種類を付けずに前景にする）。
   * 純粋な判断（テストできる）。
   */
  fun typeFor(sdk: Int, minSdk: Int, type: Int): Int? = if (sdk >= minSdk) type else null

  /**
   * 前景にする。種類は [typeFor] の判断どおり（[minSdk] より前の段では種類を付けない）。
   * 例外は呼び出し側へ返す（各サービスが、それぞれの失敗のあつかいで catch する）。
   */
  fun startForeground(service: Service, id: Int, n: Notification, minSdk: Int, type: Int) {
    val t = typeFor(Build.VERSION.SDK_INT, minSdk, type)
    if (t == null) service.startForeground(id, n) else service.startForeground(id, n, t)
  }

  /** チャンネルを作る（API 26 未満は何もしない）。同じ id で作り直すと内容は更新される */
  fun createChannel(
    context: Context,
    id: String,
    name: String,
    importance: Int,
    configure: NotificationChannel.() -> Unit,
  ) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    context.getSystemService(NotificationManager::class.java)
      .createNotificationChannel(NotificationChannel(id, name, importance).apply(configure))
  }

  /** 通話のチャンネル（両方の通話で同じ内容） */
  fun createCallChannel(context: Context) {
    createChannel(context, CALL_CHANNEL, "通話", NotificationManager.IMPORTANCE_LOW) {
      description = "通話中であることを示す"
      setShowBadge(false)
    }
  }

  /** 起動の保持（部分的・参照を数えない）を作る。取得はしない（呼び出し側が acquire する） */
  fun newPartialWakeLock(pm: PowerManager, tag: String): PowerManager.WakeLock =
    pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, tag).apply { setReferenceCounted(false) }
}
