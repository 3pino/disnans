package dev.disnans.notifier

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** サーバーの URL → WebSocket の URL、OkHttp の既定、開発用の身元の検査（純粋な部分と、クライアントの設定値） */
class ServerLinkTest {
  @Test
  fun http_and_https_map_to_ws_and_wss_with_api_ws() {
    assertEquals("ws://100.1.2.3:8080/api/ws", ServerLink.wsUrl("http://100.1.2.3:8080"))
    assertEquals("wss://host.ts.net/api/ws", ServerLink.wsUrl("https://host.ts.net"))
  }

  @Test
  fun scheme_match_ignores_case_and_only_the_scheme_changes() {
    assertEquals("ws://h/api/ws", ServerLink.wsUrl("HTTP://h"))
    assertEquals("wss://H.Example/api/ws", ServerLink.wsUrl("HTTPS://H.Example"))
  }

  @Test
  fun trailing_slashes_are_removed_once_before_api_ws() {
    assertEquals("wss://host.ts.net/api/ws", ServerLink.wsUrl("https://host.ts.net/"))
    assertEquals("wss://host.ts.net/api/ws", ServerLink.wsUrl("https://host.ts.net///"))
  }

  @Test
  fun port_is_kept() {
    assertEquals("wss://h:8443/api/ws", ServerLink.wsUrl("https://h:8443"))
    assertEquals("ws://h:80/api/ws", ServerLink.wsUrl("http://h:80/"))
  }

  @Test
  fun path_prefix_is_kept() {
    assertEquals("wss://h/disnans/api/ws", ServerLink.wsUrl("https://h/disnans"))
    assertEquals("ws://h/a/b/api/ws", ServerLink.wsUrl("http://h/a/b/"))
  }

  @Test
  fun non_http_schemes_and_bare_hosts_are_rejected() {
    for (bad in listOf("ftp://h", "ws://h", "h:8080", "", "httpx://h")) {
      try {
        ServerLink.wsUrl(bad)
        fail("accepted: $bad")
      } catch (e: IllegalArgumentException) {
        assertEquals("bad_server_url", e.message)
      }
    }
  }

  @Test
  fun native_protocol_wsUrl_keeps_the_same_mapping() {
    assertEquals(ServerLink.wsUrl("https://host.ts.net/"), NativeCallProtocol.wsUrl("https://host.ts.net/"))
    assertEquals(ServerLink.wsUrl("HTTP://h"), NativeCallProtocol.wsUrl("HTTP://h"))
  }

  @Test
  fun dev_user_must_be_non_blank_printable_ascii() {
    assertTrue(ServerLink.validDevUser("dev-user_1"))
    assertTrue(ServerLink.validDevUser("a b"))
    assertFalse(ServerLink.validDevUser(""))
    assertFalse(ServerLink.validDevUser("   "))
    assertFalse(ServerLink.validDevUser("ユーザー"))
    assertFalse(ServerLink.validDevUser("tab\there"))
    assertFalse(ServerLink.validDevUser("del\u007f"))
  }

  @Test
  fun dev_user_header_name_is_the_documented_one() {
    assertEquals("X-Dev-User", ServerLink.DEV_USER_HEADER)
  }

  @Test
  fun socket_client_defaults_ping_and_leaves_unset_timeouts_alone() {
    val notify = ServerLink.socketClient(pingSeconds = 30, readTimeoutMs = 0L)
    assertEquals(30_000, notify.pingIntervalMillis)
    assertEquals(0, notify.readTimeoutMillis)

    val call = ServerLink.socketClient(pingSeconds = 20, connectTimeoutSeconds = 10)
    assertEquals(20_000, call.pingIntervalMillis)
    assertEquals(10_000, call.connectTimeoutMillis)
    // 指定しなかった読み取りの時間切れは OkHttp の既定のまま（通話の経路は前と同じ）
    assertEquals(ServerLink.socketClient(pingSeconds = 1).readTimeoutMillis, call.readTimeoutMillis)
  }

  @Test
  fun http_client_applies_one_timeout_to_connect_read_and_call() {
    val c = ServerLink.httpClient(15)
    assertEquals(15_000, c.connectTimeoutMillis)
    assertEquals(15_000, c.readTimeoutMillis)
    assertEquals(15_000, c.callTimeoutMillis)
  }
}
