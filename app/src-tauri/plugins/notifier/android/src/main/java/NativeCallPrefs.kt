package dev.disnans.notifier

import android.content.Context
import android.content.SharedPreferences

/**
 * ネイティブの通話の保存。書くのは操作のとき（参加・停止・設定の変更）だけ。音声のフレームごとには書かない。
 * - `wanted` と通話の接続の情報（セッション）: 停止・権限の失効・キックで消す。再起動の再開にだけ使う。
 * - 音の設定（音量・上限・入力の指定）: 停止でも残す（デバイスの設定として）。
 * 書けなかったときは false を返す（呼び出し側が、安全な側に倒す）。
 */
internal class NativeCallPrefs(context: Context) : NativeCallStore {
  private val p: SharedPreferences = context.applicationContext.getSharedPreferences(NAME, Context.MODE_PRIVATE)

  /** 再起動や起動のときに読む。wanted が false なら、接続の情報は読まない */
  override fun read(): CallPersisted {
    val wanted = p.getBoolean(K_WANTED, false)
    val config = if (wanted) readConfig() else null
    val status = NativeCallStatus(
      muted = p.getBoolean(K_MUTED, false),
      deafened = p.getBoolean(K_DEAFENED, false),
      device = p.getString(K_DEVICE, null),
    )
    return CallPersisted(
      wanted = wanted && config != null,
      config = config,
      settings = readSettings(),
      status = status,
      localMuted = p.getStringSet(K_LOCAL_MUTED, emptySet()).orEmpty().toSet(),
      generation = p.getLong(K_GENERATION, 0L),
      muteByDeafen = p.getBoolean(K_MUTE_BY_DEAFEN, false),
    )
  }

  /** wanted を保存する（true は、一覧に載って音声が始まったあとだけ）。false のときは接続の情報も消す */
  override fun commitWanted(config: CallSessionConfig, status: NativeCallStatus, localMuted: Set<String>, muteByDeafen: Boolean): Boolean =
    commitWanted(true, config, status, localMuted, muteByDeafen)

  fun commitWanted(wanted: Boolean, config: CallSessionConfig?, status: NativeCallStatus, localMuted: Set<String>, muteByDeafen: Boolean): Boolean {
    val e = p.edit()
    if (wanted && config != null) {
      e.putBoolean(K_WANTED, true)
      e.putString(K_SESSION, config.session)
      e.putString(K_SERVER, config.serverUrl)
      e.putString(K_EXPECTED, config.expectedUserId)
      if (config.devUser != null) e.putString(K_DEV, config.devUser) else e.remove(K_DEV)
      e.putString(K_PEER, config.peer)
      putSession(e, status, localMuted, muteByDeafen)
    } else {
      clearSessionKeys(e)
    }
    return e.commit()
  }

  /** 接続の情報を消す（止めたとき・権限の失効・キック）。wanted は必ず false にする */
  override fun clearWanted(): Boolean = clearSessionKeys(p.edit()).commit()

  /** 操作の状態（ミュートなど）を保存する。操作のときだけ呼ぶ */
  override fun commitSession(status: NativeCallStatus, localMuted: Set<String>, muteByDeafen: Boolean): Boolean {
    val e = p.edit()
    putSession(e, status, localMuted, muteByDeafen)
    return e.commit()
  }

  override fun commitGeneration(generation: Long): Boolean = p.edit().putLong(K_GENERATION, generation).commit()

  fun readSettings(): NativeCallSettings = NativeCallSettings(
    micVolume = p.getString(K_MIC, null)?.toDoubleOrNull() ?: 1.0,
    outVolume = p.getString(K_OUT, null)?.toDoubleOrNull() ?: 1.0,
    limiter = p.getBoolean(K_LIMITER, true),
    limitDb = p.getString(K_LIMIT_DB, null)?.toDoubleOrNull() ?: NativePcm.LIMIT_DB_DEFAULT,
    rawInput = p.getBoolean(K_RAW, false),
    outputId = p.getString(K_OUTPUT, null),
  )

  override fun commitSettings(settings: NativeCallSettings): Boolean = p.edit()
    .putString(K_MIC, settings.micVolume.toString())
    .putString(K_OUT, settings.outVolume.toString())
    .putBoolean(K_LIMITER, settings.limiter)
    .putString(K_LIMIT_DB, settings.limitDb.toString())
    .putBoolean(K_RAW, settings.rawInput)
    .apply { if (settings.outputId != null) putString(K_OUTPUT, settings.outputId) else remove(K_OUTPUT) }
    .commit()

  private fun readConfig(): CallSessionConfig? {
    val session = p.getString(K_SESSION, null) ?: return null
    val server = p.getString(K_SERVER, null) ?: return null
    val expected = p.getString(K_EXPECTED, null) ?: return null
    val peer = p.getString(K_PEER, null) ?: return null
    return CallSessionConfig(session, server, expected, p.getString(K_DEV, null), peer)
  }

  private fun putSession(e: SharedPreferences.Editor, status: NativeCallStatus, localMuted: Set<String>, muteByDeafen: Boolean) {
    e.putBoolean(K_MUTE_BY_DEAFEN, muteByDeafen)
    e.putBoolean(K_MUTED, status.muted)
    e.putBoolean(K_DEAFENED, status.deafened)
    if (status.device != null) e.putString(K_DEVICE, status.device) else e.remove(K_DEVICE)
    e.putStringSet(K_LOCAL_MUTED, localMuted.toSet())
  }

  private fun clearSessionKeys(e: SharedPreferences.Editor): SharedPreferences.Editor {
    e.putBoolean(K_WANTED, false)
    for (k in listOf(K_SESSION, K_SERVER, K_EXPECTED, K_DEV, K_PEER, K_MUTED, K_DEAFENED, K_DEVICE, K_LOCAL_MUTED, K_MUTE_BY_DEAFEN)) e.remove(k)
    return e
  }

  companion object {
    /** 保存の名前（通知の設定とは別） */
    const val NAME = "disnans.nativecall"
    private const val K_WANTED = "wanted"
    private const val K_GENERATION = "generation"
    private const val K_SESSION = "session"
    private const val K_SERVER = "server_url"
    private const val K_EXPECTED = "expected_user"
    /** 開発用の ID（X-Dev-User）。待っている通話のあいだだけ残す。ログには出さない */
    private const val K_DEV = "dev_user"
    private const val K_PEER = "peer"
    private const val K_MUTED = "muted"
    private const val K_DEAFENED = "deafened"
    private const val K_DEVICE = "device"
    private const val K_LOCAL_MUTED = "local_muted"
    private const val K_MUTE_BY_DEAFEN = "mute_by_deafen"
    private const val K_MIC = "mic_volume"
    private const val K_OUT = "out_volume"
    private const val K_LIMITER = "limiter"
    private const val K_LIMIT_DB = "limit_db"
    private const val K_RAW = "raw_input"
    private const val K_OUTPUT = "output_id"
  }
}
