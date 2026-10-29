package dev.disnans.notifier

import com.fasterxml.jackson.databind.ObjectMapper
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** 実際の OkHttp の upgrade・フレームを確認する。全てローカルの合成データで、マイクは使わない。 */
class NativeCallTransportSmokeTest {
  private class Sink : NativeCallWireListener {
    val frames = LinkedBlockingQueue<ServerFrame>()
    val ends = LinkedBlockingQueue<Pair<WireFailure, Int?>>()
    override fun onOpen() = Unit
    override fun onFrame(frame: ServerFrame) { frames.add(frame) }
    override fun onClosed(failure: WireFailure, httpStatus: Int?) { ends.add(failure to httpStatus) }
    fun frame(): ServerFrame = frames.poll(5, TimeUnit.SECONDS) ?: throw AssertionError("No frame")
  }

  @Test fun realWebSocketCarriesHelloJoinPcmAndOpaqueEvents() {
    val server = MockWebServer()
    val peerSocket = AtomicReference<WebSocket>()
    val received = LinkedBlockingQueue<String>()
    server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
        peerSocket.set(webSocket)
        webSocket.send("""{"type":"hello","me":{"id":"synthetic-user","login_name":"synthetic@example.invalid"},"users":[]}""")
      }
      override fun onMessage(webSocket: WebSocket, text: String) { received.add(text) }
    }))
    server.start()
    val client = OkHttpClient()
    val sink = Sink()
    val wire = NativeCallWire(client, sink)
    try {
      wire.connect(server.url("/").toString(), "synthetic-dev")
      assertEquals("synthetic-user", (sink.frame() as ServerFrame.Hello).meId)
      val request = server.takeRequest(5, TimeUnit.SECONDS) ?: throw AssertionError("No upgrade request")
      assertEquals("/api/ws", request.path)
      assertEquals("synthetic-dev", request.getHeader("X-Dev-User"))
      val join = NativeCallProtocol.join("synthetic-peer", NativeCallStatus(false, false, "smartphone"))
      assertEquals(NativeCallWire.SendResult.SENT, wire.sendControl(join))
      assertEquals(join, received.poll(5, TimeUnit.SECONDS))
      peerSocket.get().send("""{"type":"call.state","members":[{"peer":"synthetic-peer","user_id":"synthetic-user","status":{"muted":false,"deafened":false,"device":"smartphone"}}]}""")
      assertEquals("synthetic-user", (sink.frame() as ServerFrame.CallState).members.single().userId)

      val pcm = ByteArray(1600) { (it % 31).toByte() }
      val audio = NativeCallProtocol.audio(0, pcm)
      assertEquals(NativeCallWire.SendResult.SENT, wire.sendAudio(audio))
      assertEquals(audio, received.poll(5, TimeUnit.SECONDS))
      peerSocket.get().send("""{"type":"call.event","peer":"synthetic-remote","from":"synthetic-other","name":"audio","payload":{"seq":0,"pcm":"${NativeCallProtocol.encodePcm(pcm)}"}}""")
      val incoming = sink.frame() as ServerFrame.Audio
      assertArrayEquals(pcm, incoming.pcm)
      assertEquals(0L, incoming.seq)

      val payload = ObjectMapper().readTree("""{"nested":[1,null,"synthetic"],"ok":true}""")
      val emit = NativeCallProtocol.emit("synthetic-plugin", payload)
      assertEquals(NativeCallWire.SendResult.SENT, wire.sendControl(emit))
      assertEquals(emit, received.poll(5, TimeUnit.SECONDS))
      peerSocket.get().send("""{"type":"call.event","peer":"synthetic-remote","from":"synthetic-other","name":"synthetic-plugin","payload":$payload}""")
      val relay = sink.frame() as ServerFrame.Relay
      assertEquals(payload, relay.payload)
      assertEquals("synthetic-other", relay.from)
      peerSocket.get().close(1000, null)
      assertEquals(WireFailure.REMOTE_CLOSED to null, sink.ends.poll(5, TimeUnit.SECONDS))
      assertFalse(wire.isOpen)
    } finally {
      wire.cancel()
      client.dispatcher.executorService.shutdownNow()
      client.connectionPool.evictAll()
      server.shutdown()
    }
  }

  @Test fun realHttpDenialIsTypedWithoutReturningBody() {
    val server = MockWebServer()
    server.enqueue(MockResponse().setResponseCode(403).setBody("synthetic denied body"))
    server.start()
    val client = OkHttpClient()
    val sink = Sink()
    val wire = NativeCallWire(client, sink)
    try {
      wire.connect(server.url("/").toString(), null)
      assertEquals(WireFailure.HTTP_REJECTED to 403, sink.ends.poll(5, TimeUnit.SECONDS))
      assertTrue(sink.frames.isEmpty())
      assertFalse(wire.isOpen)
    } finally {
      wire.cancel()
      client.dispatcher.executorService.shutdownNow()
      client.connectionPool.evictAll()
      server.shutdown()
    }
  }
}
