package dev.disnans.notifier

import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/**
 * サーバーへの接続の共通の決まり: URL の変換（http→ws の /api/ws）、OkHttp の既定、開発用の身元の検査。
 * 再接続・待ち時間の方針は、各経路（通知・通話・既読）がそれぞれ持つ（ここでは決めない）。
 */
internal object ServerLink {
  const val WS_PATH = "/api/ws"

  /** 開発用の身元を送るヘッダー。送るのは通話の経路（NativeCallWire）だけ。通知の経路は送らない */
  const val DEV_USER_HEADER = "X-Dev-User"

  /**
   * サーバーの URL（http / https）を、WebSocket の URL（ws / wss、末尾の / は無し、/api/ws を付ける）にする。
   * 経路の接頭辞（例: https://h/prefix/）はそのまま残す。http(s) 以外は IllegalArgumentException。
   */
  fun wsUrl(serverUrl: String): String {
    val lower = serverUrl.lowercase()
    val ws = when {
      lower.startsWith("https://") -> "wss://" + serverUrl.substring("https://".length)
      lower.startsWith("http://") -> "ws://" + serverUrl.substring("http://".length)
      else -> throw IllegalArgumentException("bad_server_url")
    }
    return ws.trimEnd('/') + WS_PATH
  }

  /** 開発用の身元として送れる値か（空でなく、表示可能な ASCII だけ）。長さの上限は呼び出し側が決める */
  fun validDevUser(devUser: String): Boolean = devUser.isNotBlank() && devUser.all { it.code in 0x20..0x7e }

  /**
   * WebSocket の接続のクライアント。[pingSeconds] ごとに ping を送って途中の切断を見つける。
   * [connectTimeoutSeconds] と [readTimeoutMs] は指定したときだけ変える（省けば OkHttp の既定）。
   */
  fun socketClient(
    pingSeconds: Long,
    connectTimeoutSeconds: Long? = null,
    readTimeoutMs: Long? = null,
  ): OkHttpClient {
    val b = OkHttpClient.Builder().pingInterval(pingSeconds, TimeUnit.SECONDS)
    connectTimeoutSeconds?.let { b.connectTimeout(it, TimeUnit.SECONDS) }
    readTimeoutMs?.let { b.readTimeout(it, TimeUnit.MILLISECONDS) }
    return b.build()
  }

  /** 普通の HTTP の口。接続・読み取り・全体の各段を同じ秒数で切る */
  fun httpClient(timeoutSeconds: Long): OkHttpClient = OkHttpClient.Builder()
    .connectTimeout(timeoutSeconds, TimeUnit.SECONDS)
    .readTimeout(timeoutSeconds, TimeUnit.SECONDS)
    .callTimeout(timeoutSeconds, TimeUnit.SECONDS)
    .build()
}
