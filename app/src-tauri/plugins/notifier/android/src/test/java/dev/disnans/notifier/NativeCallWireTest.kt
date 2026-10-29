package dev.disnans.notifier

import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * NativeCallWire over fake sockets (deterministic: queue sizes and callbacks are driven by the test).
 * A MockWebServer handshake smoke test is kept separate, because its jar is not part of the local cache.
 */
class NativeCallWireTest {
  private class FakeSocket(val request: Request, val listener: WebSocketListener) : WebSocket {
    var queued = 0L
    var sendOk = true
    val sent = ArrayList<String>()
    var closeCalls = 0
    var cancelCalls = 0

    override fun request(): Request = request
    override fun queueSize(): Long = queued
    override fun send(text: String): Boolean {
      if (!sendOk) return false
      sent.add(text)
      return true
    }
    override fun send(bytes: ByteString): Boolean = false
    override fun close(code: Int, reason: String?): Boolean {
      closeCalls++
      return true
    }
    override fun cancel() {
      cancelCalls++
    }
  }

  private class Factory : NativeCallSocketFactory {
    val sockets = ArrayList<FakeSocket>()
    var failNext = false
    var beforeReturn: (() -> Unit)? = null
    /** When set, the fake calls onOpen synchronously, before open() returns the socket. */
    var openInsideFactory = false

    override fun open(request: Request, listener: WebSocketListener): WebSocket {
      if (failNext) {
        failNext = false
        throw IOException("refused")
      }
      val s = FakeSocket(request, listener)
      sockets.add(s)
      if (openInsideFactory) {
        s.listener.onOpen(s, Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(101).message("m").build())
      }
      beforeReturn?.invoke()
      return s
    }
  }

  private class Rec : NativeCallWireListener {
    val events = java.util.Collections.synchronizedList(ArrayList<String>())
    val frames = java.util.Collections.synchronizedList(ArrayList<ServerFrame>())
    override fun onOpen() {
      events.add("open")
    }
    override fun onFrame(frame: ServerFrame) {
      frames.add(frame)
    }
    override fun onClosed(failure: WireFailure, httpStatus: Int?) {
      events.add("closed:$failure:$httpStatus")
    }
  }

  private val status = NativeCallStatus(muted = false, deafened = false, device = "smartphone")
  private val helloText = """{"type":"hello","me":{"id":"u1","login_name":"a@x"},"users":[]}"""

  private fun response(req: Request, code: Int): Response =
    Response.Builder().request(req).protocol(Protocol.HTTP_1_1).code(code).message("m").build()

  private fun connected(f: Factory, index: Int = f.sockets.size - 1): FakeSocket {
    val s = f.sockets[index]
    s.listener.onOpen(s, response(s.request, 101))
    return s
  }

  private fun newWire(): Triple<Factory, NativeCallWire, Rec> {
    val f = Factory()
    val r = Rec()
    return Triple(f, NativeCallWire.withFactory(f, r), r)
  }

  @Test fun connectBuildsWsUrlAndDevUserHeaderOnlyWhenGiven() {
    val (f, w, _) = newWire()
    w.connect("https://host.ts.net", null)
    val req = f.sockets[0].request
    // OkHttp keeps wss as https and ws as http inside HttpUrl; the wire scheme is set by the server URL.
    assertEquals("https", req.url.scheme)
    assertEquals("/api/ws", req.url.encodedPath)
    assertNull(req.header("X-Dev-User"))

    w.connect("http://127.0.0.1:8080", "alice@test")
    assertEquals("alice@test", f.sockets[1].request.header("X-Dev-User"))
  }

  @Test fun badInputIsRefusedWithSafeCodes() {
    val (_, w, _) = newWire()
    assertEquals("bad_server_url", expectCode { w.connect("ftp://x", null) })
    assertEquals("bad_dev_user", expectCode { w.connect("http://x", "æ") })
    assertEquals("bad_dev_user", expectCode { w.connect("http://x", " ") })
  }

  @Test fun sendsOnlyWhileOpenAndReportsSentAndNotOpen() {
    val (f, w, r) = newWire()
    assertEquals(NativeCallWire.SendResult.NOT_OPEN, w.sendControl(NativeCallProtocol.leave()))
    w.connect("http://x", null)
    assertFalse(w.isOpen)
    val s = connected(f)
    assertTrue(w.isOpen)
    assertEquals(listOf("open"), r.events.toList())
    assertEquals(NativeCallWire.SendResult.SENT, w.sendControl(NativeCallProtocol.join("p1", status)))
    assertEquals(1, s.sent.size)
    s.sendOk = false
    assertEquals(NativeCallWire.SendResult.NOT_OPEN, w.sendControl(NativeCallProtocol.alive()))
  }

  @Test fun decodedFramesAreDeliveredAndBadFramesCloseOnce() {
    val (f, w, r) = newWire()
    w.connect("http://x", null)
    val s = connected(f)
    s.listener.onMessage(s, helloText)
    assertTrue(r.frames[0] is ServerFrame.Hello)
    s.listener.onMessage(s, "{")
    assertEquals(listOf("open", "closed:PROTOCOL:null"), r.events.toList())
    assertEquals(1, s.cancelCalls)
    s.listener.onMessage(s, helloText) // after terminal: ignored
    assertEquals(1, r.frames.size)
    assertFalse(w.isOpen)
  }

  @Test fun remoteCloseIsTerminalOnce() {
    val (f, w, r) = newWire()
    w.connect("http://x", null)
    val s = connected(f)
    s.listener.onClosed(s, 1000, "bye")
    s.listener.onClosed(s, 1000, "bye")
    s.listener.onFailure(s, IOException("late"), null)
    assertEquals(listOf("open", "closed:REMOTE_CLOSED:null"), r.events.toList())
  }

  @Test fun httpRejectionCarriesStatusAndConnectFailureDoesNot() {
    val (f, w, r) = newWire()
    w.connect("http://x", null)
    val s = f.sockets[0]
    s.listener.onFailure(s, IOException("401"), response(s.request, 401))
    assertEquals(listOf("closed:HTTP_REJECTED:401"), r.events.toList())

    w.connect("http://x", null)
    val s2 = f.sockets[1]
    s2.listener.onFailure(s2, IOException("403"), response(s2.request, 403))
    assertEquals("closed:HTTP_REJECTED:403", r.events[1])

    w.connect("http://x", null)
    val s3 = f.sockets[2]
    s3.listener.onFailure(s3, IOException("dns"), null)
    assertEquals("closed:CONNECT_FAILED:null", r.events[2])
  }

  @Test fun factoryFailureIsConnectFailed() {
    val (f, w, r) = newWire()
    f.failNext = true
    w.connect("http://x", null)
    assertEquals(listOf("closed:CONNECT_FAILED:null"), r.events.toList())
    assertFalse(w.isOpen)
  }

  @Test fun audioDropsAtTheProjectedCapWithoutClosing() {
    val (f, w, r) = newWire()
    w.connect("http://x", null)
    val s = connected(f)
    val text = "x".repeat(100)
    val cap = NativeCallWire.AUDIO_QUEUE_LIMIT_BYTES
    s.queued = cap - 100 // exactly at the cap: allowed
    assertEquals(NativeCallWire.SendResult.SENT, w.sendAudio(text))
    s.queued = cap - 99 // one byte over: dropped
    assertEquals(NativeCallWire.SendResult.DROPPED_AUDIO, w.sendAudio(text))
    assertEquals(NativeCallWire.SendResult.SENT, w.sendControl(NativeCallProtocol.alive()))
    assertEquals(listOf("open"), r.events.toList())
  }

  @Test fun audioCapCountsUtf8BytesNotChars() {
    val (f, w, _) = newWire()
    w.connect("http://x", null)
    val s = connected(f)
    val text = "é".repeat(100) // 100 chars, 200 UTF-8 bytes
    s.queued = NativeCallWire.AUDIO_QUEUE_LIMIT_BYTES - 200
    assertEquals(NativeCallWire.SendResult.SENT, w.sendAudio(text))
    s.queued = NativeCallWire.AUDIO_QUEUE_LIMIT_BYTES - 199
    assertEquals(NativeCallWire.SendResult.DROPPED_AUDIO, w.sendAudio(text))
  }

  @Test fun controlOverflowAtTheCapClosesOnceWithOverflow() {
    val (f, w, r) = newWire()
    w.connect("http://x", null)
    val s = connected(f)
    val text = "y".repeat(1000)
    s.queued = NativeCallWire.CONTROL_QUEUE_LIMIT_BYTES - 1000 // exactly at the cap: allowed
    assertEquals(NativeCallWire.SendResult.SENT, w.sendControl(text))
    s.queued = NativeCallWire.CONTROL_QUEUE_LIMIT_BYTES - 999 // one over: overflow
    assertEquals(NativeCallWire.SendResult.OVERFLOW_CLOSED, w.sendControl(text))
    assertEquals(listOf("open", "closed:OVERFLOW:null"), r.events.toList())
    assertEquals(1, s.cancelCalls)
    assertEquals(NativeCallWire.SendResult.NOT_OPEN, w.sendControl(text))
  }

  @Test fun staleCallbacksFromAnOldAttemptNeverTouchTheNewOne() {
    val (f, w, r) = newWire()
    w.connect("http://x", null)
    val s1 = connected(f, 0)
    assertEquals(listOf("open"), r.events.toList())
    w.connect("http://x", null) // replaces attempt 1 silently
    assertEquals(1, s1.cancelCalls)
    s1.listener.onFailure(s1, IOException("old"), null)
    s1.listener.onMessage(s1, helloText)
    s1.listener.onClosed(s1, 1000, "old")
    assertEquals(listOf("open"), r.events.toList())
    assertEquals(0, r.frames.size)
    val s2 = connected(f, 1)
    assertEquals(listOf("open", "open"), r.events.toList())
    // a stale callback that names the NEW socket still belongs to the OLD attempt: it must not close attempt 2
    s1.listener.onFailure(s2, IOException("wrong socket"), null)
    assertEquals(listOf("open", "open"), r.events.toList())
    assertTrue(w.isOpen)
    assertEquals(NativeCallWire.SendResult.SENT, w.sendControl(NativeCallProtocol.alive()))
    assertEquals(1, s2.sent.size)
    assertEquals(0, s1.sent.size)
  }

  @Test fun closeAndCancelAreSilentAndIdempotent() {
    val (f, w, r) = newWire()
    w.connect("http://x", null)
    val s = connected(f)
    w.close()
    w.close()
    assertEquals(1, s.closeCalls)
    s.listener.onClosed(s, 1000, "")
    s.listener.onFailure(s, IOException("x"), null)
    assertEquals(listOf("open"), r.events.toList())
    assertFalse(w.isOpen)

    w.connect("http://x", null)
    val s2 = connected(f)
    w.cancel()
    w.cancel()
    assertEquals(1, s2.cancelCalls)
    assertEquals(listOf("open", "open"), r.events.toList())
  }

  @Test fun terminalCallbackIsExactlyOnceEvenWithDuplicateFailures() {
    val (f, w, r) = newWire()
    w.connect("http://x", null)
    val s = f.sockets[0]
    s.listener.onFailure(s, IOException("a"), null)
    s.listener.onFailure(s, IOException("b"), response(s.request, 500))
    s.listener.onClosed(s, 1011, "")
    assertEquals(listOf("closed:CONNECT_FAILED:null"), r.events.toList())
  }

  @Test fun connectDuringFactoryCallReturnsCleanly() {
    val f = Factory()
    val r = Rec()
    lateinit var w: NativeCallWire
    w = NativeCallWire.withFactory(f, r)
    f.beforeReturn = { w.cancel() } // retire the attempt before connect() assigns its socket
    w.connect("http://x", null)
    assertEquals(1, f.sockets[0].cancelCalls)
    assertEquals(emptyList<String>(), r.events.toList())
    assertFalse(w.isOpen)
  }

  @Test fun synchronousOpenInsideFactoryAllowsSendControl() {
    val f = Factory()
    f.openInsideFactory = true
    val results = ArrayList<NativeCallWire.SendResult>()
    lateinit var w: NativeCallWire
    val r = object : NativeCallWireListener {
      override fun onOpen() {
        results.add(w.sendControl(NativeCallProtocol.join("p1", status)))
      }
      override fun onFrame(frame: ServerFrame) {}
      override fun onClosed(failure: WireFailure, httpStatus: Int?) {}
    }
    w = NativeCallWire.withFactory(f, r)
    w.connect("http://x", null)
    assertEquals(listOf(NativeCallWire.SendResult.SENT), results)
    assertEquals(1, f.sockets[0].sent.size)
    assertTrue(w.isOpen)
  }

  @Test fun cancelFromOnOpenInsideFactoryIsSilentAndLeavesNoLiveSocket() {
    val f = Factory()
    f.openInsideFactory = true
    val r = Rec()
    lateinit var w: NativeCallWire
    val inner = object : NativeCallWireListener {
      override fun onOpen() {
        r.events.add("open")
        w.cancel()
      }
      override fun onFrame(frame: ServerFrame) = r.onFrame(frame)
      override fun onClosed(failure: WireFailure, httpStatus: Int?) = r.onClosed(failure, httpStatus)
    }
    w = NativeCallWire.withFactory(f, inner)
    w.connect("http://x", null)
    assertEquals(listOf("open"), r.events.toList())
    assertFalse(w.isOpen)
    assertTrue(f.sockets[0].cancelCalls >= 1)
    assertEquals(NativeCallWire.SendResult.NOT_OPEN, w.sendControl(NativeCallProtocol.alive()))
  }

  @Test fun reconnectFromOnOpenInsideFactoryKeepsTheNewAttemptAlive() {
    val f = Factory()
    f.openInsideFactory = true
    val r = Rec()
    lateinit var w: NativeCallWire
    var nested = false
    val inner = object : NativeCallWireListener {
      override fun onOpen() {
        if (!nested) {
          nested = true
          w.connect("http://y", null) // retires the outer attempt; the inner one opens inside its own factory call
        }
      }
      override fun onFrame(frame: ServerFrame) = r.onFrame(frame)
      override fun onClosed(failure: WireFailure, httpStatus: Int?) = r.onClosed(failure, httpStatus)
    }
    w = NativeCallWire.withFactory(f, inner)
    w.connect("http://x", null)
    assertEquals(2, f.sockets.size)
    // the outer attempt was retired and cancelled (the outer connect's stale check may cancel it again: harmless)
    assertTrue(f.sockets[0].cancelCalls >= 1)
    assertEquals(0, f.sockets[1].cancelCalls) // the newer attempt is untouched
    assertTrue(w.isOpen)
    assertEquals(NativeCallWire.SendResult.SENT, w.sendControl(NativeCallProtocol.alive()))
    assertEquals(1, f.sockets[1].sent.size)
    assertEquals(0, f.sockets[0].sent.size)
    assertTrue(r.events.none { it.startsWith("closed") })
  }

  @Test fun listenerMayReenterWithoutDeadlock() {
    val f = Factory()
    lateinit var w: NativeCallWire
    val r = object : NativeCallWireListener {
      val events = ArrayList<String>()
      override fun onOpen() {
        events.add("open")
        w.sendControl(NativeCallProtocol.alive())
      }
      override fun onFrame(frame: ServerFrame) {
        w.close()
        events.add("frame")
      }
      override fun onClosed(failure: WireFailure, httpStatus: Int?) {
        events.add("closed:$failure")
        w.cancel()
      }
    }
    w = NativeCallWire.withFactory(f, r)
    w.connect("http://x", null)
    val s = f.sockets[0]
    s.listener.onOpen(s, response(s.request, 101))
    s.listener.onMessage(s, helloText)
    assertEquals(listOf("open", "frame"), r.events)
    assertEquals(1, s.sent.size)
  }

  @Test fun queuedBytesFollowsTheLiveSocketOnly() {
    val (f, w, _) = newWire()
    assertEquals(0L, w.queuedBytes)
    w.connect("http://x", null)
    val s = connected(f)
    s.queued = 77
    assertEquals(77L, w.queuedBytes)
    w.cancel()
    assertEquals(0L, w.queuedBytes)
  }

  @Test fun framesRacingCancelNeverThrowAndStopAfterCancel() {
    val (f, w, r) = newWire()
    w.connect("http://x", null)
    val s = connected(f)
    val pool = Executors.newFixedThreadPool(2)
    val start = CountDownLatch(1)
    val reader = pool.submit {
      start.await()
      repeat(2000) { s.listener.onMessage(s, helloText) }
    }
    val canceller = pool.submit {
      start.await()
      w.cancel()
    }
    start.countDown()
    reader.get(10, TimeUnit.SECONDS)
    canceller.get(10, TimeUnit.SECONDS)
    pool.shutdown()
    val seen = r.frames.size
    s.listener.onMessage(s, helloText)
    assertEquals(seen, r.frames.size)
    assertFalse(r.events.any { it.startsWith("closed") })
  }

  @Test fun newConnectAfterTerminalWorksAgain() {
    val (f, w, r) = newWire()
    w.connect("http://x", null)
    val s = f.sockets[0]
    s.listener.onFailure(s, IOException("x"), null)
    w.connect("http://x", null)
    connected(f, 1)
    assertEquals(listOf("closed:CONNECT_FAILED:null", "open"), r.events.toList())
    assertNotNull(f.sockets[1])
  }

  private fun expectCode(block: () -> Unit): String {
    try {
      block()
    } catch (e: NativeCallProtocolException) {
      return e.code
    }
    fail("expected NativeCallProtocolException")
    return ""
  }
}
