package dev.disnans.notifier

/**
 * 操作の振動（タッチの合図と WebView の標準の振動）を鳴らしてよいかの判断。Android の部品に依らない部分（JVM のテストで確かめる）。
 *
 * - 鳴らしてよい条件（すべて満たすとき。1 つでも欠けるか分からないときは鳴らさない＝閉じた側に倒す）:
 *   1. アプリの設定（hapticsEnabled。既定はオン）
 *   2. 着信音のモードがサイレントでない（バイブ・通常は可）
 *   3. 集中モード（おやすみモード）が「すべて許可」（優先のみ・アラームのみ・オフは不可）
 * - デバイスの「タッチ操作の振動」のシステム設定は読まない（アプリの設定で決める）。OS が強制的に止める振動は、こちらでは超えられない。
 * - 用途はタッチ操作の振動（USAGE_TOUCH）だけ。通知・通話・アラームの用途は使わない（集中モードや着信音を迂回しない）。
 */
internal object HapticsPolicy {
  /** 鳴らすときの振動の長さ（ms）の上下限と既定（従来の値） */
  const val MS_MIN = 1L
  const val MS_MAX = 1000L
  const val MS_DEFAULT = 12L

  /** AudioManager.RINGER_MODE_* と同じ値（SDK の定数の値を写す。テストで値を固定する） */
  const val RINGER_SILENT = 0
  const val RINGER_VIBRATE = 1
  const val RINGER_NORMAL = 2

  /** NotificationManager.INTERRUPTION_FILTER_* と同じ値 */
  const val FILTER_ALL = 1
  const val FILTER_PRIORITY = 2
  const val FILTER_NONE = 3
  const val FILTER_ALARMS = 4

  enum class Ringer { SILENT, VIBRATE, NORMAL, UNKNOWN }
  enum class Dnd { ALL, PRIORITY, NONE, ALARMS, UNKNOWN }

  /** 判断の材料（読めなかったものは UNKNOWN / null） */
  data class Snapshot(
    val appEnabled: Boolean,
    val ringer: Ringer?,
    val dnd: Dnd?,
    val hasVibrator: Boolean,
  )

  sealed class Decision {
    object Vibrate : Decision()

    /** 鳴らさない理由（固定の語だけ） */
    data class Skip(val code: String) : Decision()
  }

  fun clampMs(ms: Long): Long = ms.coerceIn(MS_MIN, MS_MAX)

  /** 省かれた「アプリの設定」は有効（既存の JS の呼び方のまま）。明示の false だけ無効 */
  fun appFlagFrom(value: Boolean?): Boolean = value ?: true

  fun ringerOf(value: Int?): Ringer = when (value) {
    RINGER_SILENT -> Ringer.SILENT
    RINGER_VIBRATE -> Ringer.VIBRATE
    RINGER_NORMAL -> Ringer.NORMAL
    else -> Ringer.UNKNOWN
  }

  fun dndOf(filter: Int?): Dnd = when (filter) {
    FILTER_ALL -> Dnd.ALL
    FILTER_PRIORITY -> Dnd.PRIORITY
    FILTER_NONE -> Dnd.NONE
    FILTER_ALARMS -> Dnd.ALARMS
    else -> Dnd.UNKNOWN
  }

  /** 鳴らしてよいか（振動器の有無を除く）。WebView の標準の振動の flag と、明示の振動で同じ判断を使う */
  fun allowed(appEnabled: Boolean, ringer: Ringer?, dnd: Dnd?): Boolean {
    if (!appEnabled) return false
    val ringerOk = ringer == Ringer.VIBRATE || ringer == Ringer.NORMAL
    val dndOk = dnd == Dnd.ALL
    return ringerOk && dndOk
  }

  /** 順番に確かめる。最初に引っかかった理由を返す */
  fun decide(s: Snapshot): Decision {
    if (!s.appEnabled) return Decision.Skip("app_off")
    if (!s.hasVibrator) return Decision.Skip("no_vibrator")
    when (s.ringer) {
      null, Ringer.UNKNOWN -> return Decision.Skip("unknown_ringer")
      Ringer.SILENT -> return Decision.Skip("ringer_silent")
      Ringer.VIBRATE, Ringer.NORMAL -> Unit
    }
    return when (s.dnd) {
      null, Dnd.UNKNOWN -> Decision.Skip("unknown_dnd")
      Dnd.ALL -> Decision.Vibrate
      Dnd.PRIORITY, Dnd.NONE, Dnd.ALARMS -> Decision.Skip("dnd")
    }
  }
}
