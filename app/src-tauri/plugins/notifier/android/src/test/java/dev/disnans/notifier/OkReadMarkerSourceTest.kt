package dev.disnans.notifier

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.ResponseBody.Companion.asResponseBody
import okio.Buffer
import okio.Source
import okio.Timeout
import okio.buffer
import java.io.IOException
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** 既読の位置の本物の取得（HTTP）を、偽のサーバーで確かめる（GET・応答の読み方・取り消し・失敗の理由） */
class OkReadMarkerSourceTest {
  private lateinit var server: MockWebServer

  @Before
  fun setUp() {
    server = MockWebServer()
    server.start()
  }

  @After
  fun tearDown() {
    // 途中で止めた応答（遅い本文）が残っても、後始末で落とさない
    try {
      server.shutdown()
    } catch (ex: IOException) {
      // 待ちきれなかった接続は、テストの結果とは関係ない
    }
  }

  private fun base(): String = server.url("/").toString().trimEnd('/')

  /** 取得して、結果が届くまで待つ */
  private fun fetch(base: String, cancelFirst: Boolean = false, client: OkHttpClient = OkHttpClient()): ReadFetch? {
    val latch = CountDownLatch(1)
    var out: ReadFetch? = null
    val cancel = OkReadMarkerSource(client).fetch(base) {
      out = it
      latch.countDown()
    }
    if (cancelFirst) cancel()
    latch.await(10, TimeUnit.SECONDS)
    return out
  }

  @Test
  fun reads_the_first_marker_with_a_get_to_api_me_read() {
    server.enqueue(MockResponse().setBody("""[{"last_read_id":"01HXYZ","unread_count":3}]"""))
    assertEquals(ReadFetch.Ok("01HXYZ"), fetch(base()))
    val req = server.takeRequest()
    assertEquals("GET", req.method)
    assertEquals("/api/me/read", req.path)
  }

  @Test
  fun a_server_error_is_reported_as_http() {
    server.enqueue(MockResponse().setResponseCode(500).setBody("{}"))
    assertEquals(ReadFetch.Failed("http"), fetch(base()))
  }

  @Test
  fun a_body_of_the_wrong_shape_is_reported_as_parse() {
    server.enqueue(MockResponse().setBody("""{"last_read_id":"01"}"""))
    assertEquals(ReadFetch.Failed("parse"), fetch(base()))
  }

  @Test
  fun a_cancelled_read_reports_canceled_and_does_not_wait_for_the_body() {
    server.enqueue(MockResponse().setBody("""[{"last_read_id":"01"}]""").setBodyDelay(3, TimeUnit.SECONDS))
    assertEquals(ReadFetch.Failed("canceled"), fetch(base(), cancelFirst = true))
  }

  @Test
  fun an_unreachable_server_reports_network() {
    // 使われていないポート（つながらない）
    assertEquals(ReadFetch.Failed("network"), fetch("http://127.0.0.1:1"))
  }

  @Test
  fun a_bad_url_reports_url() {
    assertEquals(ReadFetch.Failed("url"), fetch("http://[bad"))
  }

  @Test
  fun a_body_that_fails_while_reading_is_reported_as_network_and_does_not_escape() {
    // 本文の読み取りだけが IOException で失敗する（途中で切れた本文と同じ経路）。受け手では投げず、固定の理由で返す
    server.enqueue(MockResponse().setBody("""[{"last_read_id":"01"}]"""))
    val failingBody = object : Source {
      override fun read(sink: Buffer, byteCount: Long): Long = throw IOException("cut")
      override fun timeout(): Timeout = Timeout.NONE
      override fun close() {}
    }
    val client = OkHttpClient.Builder()
      .addInterceptor { chain ->
        val r = chain.proceed(chain.request())
        r.newBuilder().body(failingBody.buffer().asResponseBody(r.body?.contentType(), -1L)).build()
      }
      .build()
    assertEquals(ReadFetch.Failed("network"), fetch(base(), client = client))
  }

  @Test
  fun a_response_slower_than_the_total_call_timeout_is_reported_as_timeout() {
    server.enqueue(MockResponse().setBody("""[{"last_read_id":"01"}]""").setBodyDelay(3, TimeUnit.SECONDS))
    val client = OkHttpClient.Builder().callTimeout(500, TimeUnit.MILLISECONDS).build()
    assertEquals(ReadFetch.Failed("timeout"), fetch(base(), client = client))
  }

  @Test
  fun the_read_client_has_a_fifteen_second_total_bound_and_per_step_timeouts() {
    val client = newReadMarkerClient()
    assertEquals(15_000, client.callTimeoutMillis)
    assertEquals(15_000, client.connectTimeoutMillis)
    assertEquals(15_000, client.readTimeoutMillis)
  }
}
