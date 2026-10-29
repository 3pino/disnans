package dev.disnans.notifier

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

// Dedicated call WebSocket (contract v1). One logical socket at a time; the engine owns every retry.
//
// Ownership: every connect() creates an Attempt. All state changes go through `lock`. Callbacks from an
// old attempt see `done` and do nothing, so they can never clear or emit into a newer attempt.
// Listener code is never invoked while `lock` is held. Each attempt reports exactly one terminal callback
// (onClosed), except close()/cancel()/connect-replace, which are silent.
//
// No logging here: URLs, identities, and payloads must never reach logs.

/** Why the socket ended. Fixed values only; the engine chooses retry behaviour from these. */
enum class WireFailure {
  /** Network or TLS failure before the upgrade completed. */
  CONNECT_FAILED,
  /** The server answered the upgrade with an HTTP status (see httpStatus). */
  HTTP_REJECTED,
  /** Bad frame from the server (malformed JSON or a malformed known frame). */
  PROTOCOL,
  /** Outgoing control queue would exceed [NativeCallWire.CONTROL_QUEUE_LIMIT_BYTES]. Socket closed. */
  OVERFLOW,
  /** The server closed the socket. */
  REMOTE_CLOSED,
  /** The socket failed for another reason (for example an internal OkHttp error). */
  FAILED,
}

/** Callbacks run on OkHttp threads, never under the wire lock. The engine must marshal them to its own thread. */
interface NativeCallWireListener {
  fun onOpen()
  fun onFrame(frame: ServerFrame)
  /** Terminal for one attempt. Not called after [NativeCallWire.close], [NativeCallWire.cancel] or a replacing connect(). */
  fun onClosed(failure: WireFailure, httpStatus: Int?)
}

/** Creates the underlying socket. The OkHttp client is the production implementation; tests inject fakes. */
fun interface NativeCallSocketFactory {
  fun open(request: Request, listener: WebSocketListener): WebSocket
}

class NativeCallWire private constructor(
  private val sockets: NativeCallSocketFactory,
  private val listener: NativeCallWireListener,
) {
  constructor(client: OkHttpClient, listener: NativeCallWireListener) : this(
    NativeCallSocketFactory { request, l -> client.newWebSocket(request, l) },
    listener,
  )

  /** Result of a send. Audio drops are counted by the engine; they are never resent. */
  enum class SendResult {
    SENT,
    /** Audio refused: projected queue would exceed [AUDIO_QUEUE_LIMIT_BYTES]. Socket stays open. */
    DROPPED_AUDIO,
    /** No open socket (not connected, closed, or still handshaking). */
    NOT_OPEN,
    /** Control refused: projected queue would exceed [CONTROL_QUEUE_LIMIT_BYTES]. Socket closed (OVERFLOW reported once). */
    OVERFLOW_CLOSED,
  }

  /** One connect() call. Guarded by [lock]. */
  private class Attempt {
    var socket: WebSocket? = null
    var open = false
    var done = false
  }

  private val lock = Any()
  private var current: Attempt? = null

  /** Bytes queued in OkHttp, not yet written. 0 when there is no open socket. */
  val queuedBytes: Long
    get() {
      val ws = synchronized(lock) { current?.takeIf { it.open && !it.done }?.socket } ?: return 0L
      return ws.queueSize()
    }

  val isOpen: Boolean
    get() = synchronized(lock) { current?.let { it.open && !it.done } ?: false }

  /**
   * Opens the call socket for [serverUrl] (http/https; mapped to ws/wss + `/api/ws`).
   * [devUser] is sent as X-Dev-User only when given (development). Throws [NativeCallProtocolException] for bad input.
   * A new connect() silently retires the previous attempt (no terminal callback for it).
   */
  fun connect(serverUrl: String, devUser: String?) {
    val url = NativeCallProtocol.wsUrl(serverUrl)
    val builder = try {
      Request.Builder().url(url)
    } catch (_: IllegalArgumentException) {
      throw NativeCallProtocolException("bad_server_url")
    }
    if (devUser != null) {
      if (devUser.isBlank() || !devUser.all { it.code in 0x20..0x7e }) throw NativeCallProtocolException("bad_dev_user")
      builder.header(DEV_USER_HEADER, devUser)
    }
    val request = builder.build()

    val attempt = Attempt()
    val retired: WebSocket? = synchronized(lock) {
      val previous = current
      current = attempt
      if (previous == null) {
        null
      } else {
        previous.done = true
        previous.open = false
        previous.socket
      }
    }
    retired?.cancel()

    val ws = try {
      sockets.open(request, Socket(attempt))
    } catch (_: Exception) {
      finish(attempt, WireFailure.CONNECT_FAILED, null)
      return
    }
    val stale = synchronized(lock) {
      if (attempt.done) {
        true
      } else {
        attempt.socket = ws
        false
      }
    }
    if (stale) ws.cancel()
  }

  /** Sends a control frame. Refused only when the projected queue would exceed the control cap (then closes). */
  fun sendControl(text: String): SendResult {
    val (attempt, ws) = liveSocket() ?: return SendResult.NOT_OPEN
    val projected = ws.queueSize() + NativeCallProtocol.utf8Length(text)
    if (projected > CONTROL_QUEUE_LIMIT_BYTES) {
      finish(attempt, WireFailure.OVERFLOW, null)
      return SendResult.OVERFLOW_CLOSED
    }
    return if (ws.send(text)) SendResult.SENT else SendResult.NOT_OPEN
  }

  /** Sends an audio frame. Dropped (never resent) when the projected queue would exceed the audio cap. */
  fun sendAudio(text: String): SendResult {
    val (_, ws) = liveSocket() ?: return SendResult.NOT_OPEN
    val projected = ws.queueSize() + NativeCallProtocol.utf8Length(text)
    if (projected > AUDIO_QUEUE_LIMIT_BYTES) return SendResult.DROPPED_AUDIO
    return if (ws.send(text)) SendResult.SENT else SendResult.NOT_OPEN
  }

  /** Graceful close, silent (no terminal callback). Idempotent. */
  fun close() {
    val ws = retire() ?: return
    ws.close(NORMAL_CLOSE, null)
  }

  /** Immediate teardown, silent. Idempotent. */
  fun cancel() {
    val ws = retire() ?: return
    ws.cancel()
  }

  /** Returns the live (open, not done) attempt and its socket, or null. */
  private fun liveSocket(): Pair<Attempt, WebSocket>? = synchronized(lock) {
    val a = current ?: return null
    if (!a.open || a.done) return null
    val ws = a.socket ?: return null
    Pair(a, ws)
  }

  /** Marks the current attempt done without a callback and returns its socket (if assigned). */
  private fun retire(): WebSocket? = synchronized(lock) {
    val a = current ?: return null
    if (a.done) return null
    a.done = true
    a.open = false
    current = null
    a.socket
  }

  /**
   * Ends one attempt with a terminal callback, exactly once. Cancels the socket (no-op if already closed).
   * The callback runs after the lock is released.
   */
  private fun finish(a: Attempt, failure: WireFailure, status: Int?) {
    val ws = synchronized(lock) {
      if (a.done) return
      a.done = true
      a.open = false
      if (current === a) current = null
      a.socket
    }
    ws?.cancel()
    listener.onClosed(failure, status)
  }

  private inner class Socket(private val attempt: Attempt) : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
      // The callback can run before connect() has stored the returned socket (synchronous factory or a fast
      // handshake). Record this attempt's own socket here, under the lock, so sends made from onOpen see it.
      val fire = synchronized(lock) {
        if (attempt.done) {
          false
        } else {
          if (attempt.socket == null) attempt.socket = webSocket
          attempt.open = true
          true
        }
      }
      if (fire) listener.onOpen()
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      if (!isLive()) return
      val frame = try {
        NativeCallProtocol.decode(text)
      } catch (_: NativeCallProtocolException) {
        finish(attempt, WireFailure.PROTOCOL, null)
        return
      }
      // The attempt may have ended while decoding; a stale frame is dropped.
      if (!isLive()) return
      listener.onFrame(frame)
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
      // The server asked us to close: answer. onClosed then reports REMOTE_CLOSED (once).
      webSocket.close(code, null)
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
      finish(attempt, WireFailure.REMOTE_CLOSED, null)
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
      if (response != null) {
        finish(attempt, WireFailure.HTTP_REJECTED, response.code)
      } else {
        finish(attempt, WireFailure.CONNECT_FAILED, null)
      }
    }

    private fun isLive(): Boolean = synchronized(lock) { attempt.open && !attempt.done }
  }

  companion object {
    const val DEV_USER_HEADER = "X-Dev-User"

    /** Audio is dropped when the projected queued bytes would exceed this (about 14 frames; roughly 0.7 s). */
    const val AUDIO_QUEUE_LIMIT_BYTES: Long = 32L * 1024L

    /** Control frames close the socket when the projected queued bytes would exceed this. */
    const val CONTROL_QUEUE_LIMIT_BYTES: Long = 256L * 1024L

    private const val NORMAL_CLOSE = 1000

    /** Wire with an injected socket factory (tests and fakes). Production uses the OkHttpClient constructor. */
    fun withFactory(sockets: NativeCallSocketFactory, listener: NativeCallWireListener): NativeCallWire =
      NativeCallWire(sockets, listener)
  }
}
