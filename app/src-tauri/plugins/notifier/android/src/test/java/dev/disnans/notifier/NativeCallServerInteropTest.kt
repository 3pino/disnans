package dev.disnans.notifier

import com.fasterxml.jackson.databind.ObjectMapper
import okhttp3.OkHttpClient
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.ServerSocket
import java.net.URL
import java.nio.file.Files
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/** 現在の Rust サーバーと実際の NativeCallWire を接続する。データも音声も合成、保存先は毎回一時フォルダ。 */
class NativeCallServerInteropTest {
  private class Sink : NativeCallWireListener {
    val frames = LinkedBlockingQueue<ServerFrame>()
    override fun onOpen() = Unit
    override fun onFrame(frame: ServerFrame) { frames.add(frame) }
    override fun onClosed(failure: WireFailure, httpStatus: Int?) = Unit
    fun until(predicate: (ServerFrame) -> Boolean): ServerFrame {
      val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
      while (true) {
        val left = deadline - System.nanoTime()
        if (left <= 0) throw AssertionError("Expected server frame did not arrive")
        val frame = frames.poll(left, TimeUnit.NANOSECONDS) ?: throw AssertionError("No server frame")
        if (predicate(frame)) return frame
      }
    }
  }

  @Test fun currentServerSupportsStablePeerReplacementAndOpaqueRelay() {
    val binary = System.getenv("DISNANS_NATIVE_TEST_SERVER_BIN")
    assumeTrue("Set DISNANS_NATIVE_TEST_SERVER_BIN to a freshly built test server", !binary.isNullOrBlank())
    val executable = File(binary!!).absoluteFile
    assertTrue("Test server binary must exist", executable.isFile)
    val temp = Files.createTempDirectory("disnans-native-server-").toFile()
    val port = ServerSocket(0).use { it.localPort }
    val base = "http://127.0.0.1:$port"
    val builder = ProcessBuilder(executable.path).directory(temp).redirectErrorStream(true).redirectOutput(File(temp, "server.log"))
    val env = builder.environment()
    for (key in env.keys.filter { it.startsWith("DISNANS_") }) env.remove(key)
    env["DISNANS_DATA_DIR"] = File(temp, "data").path
    env["DISNANS_BIND"] = "127.0.0.1:$port"
    env["DISNANS_DEV"] = "1"
    env["DISNANS_AUTO_UPDATE"] = "0"
    env["DISNANS_BACKUP"] = "0"
    env["RUST_LOG"] = "error"
    val process = builder.start()
    val client = OkHttpClient()
    val aSink = Sink()
    val bSink = Sink()
    val replacementSink = Sink()
    val a = NativeCallWire(client, aSink)
    val b = NativeCallWire(client, bSink)
    val replacement = NativeCallWire(client, replacementSink)
    try {
      waitForHealth(base, process)
      val dev = "native-interop@example.invalid"
      val status = NativeCallStatus(false, false, "smartphone")
      a.connect(base, dev)
      val me = (aSink.until { it is ServerFrame.Hello } as ServerFrame.Hello).meId
      assertEquals(NativeCallWire.SendResult.SENT, a.sendControl(NativeCallProtocol.join("interop-a", status)))
      aSink.until { it is ServerFrame.CallState && it.members.any { m -> m.peer == "interop-a" && m.userId == me } }
      b.connect(base, dev)
      assertEquals(me, (bSink.until { it is ServerFrame.Hello } as ServerFrame.Hello).meId)
      assertEquals(NativeCallWire.SendResult.SENT, b.sendControl(NativeCallProtocol.join("interop-b", status)))
      bSink.until { it is ServerFrame.CallState && it.members.map { m -> m.peer }.toSet() == setOf("interop-a", "interop-b") }
      val pcm = ByteArray(1600) { (it % 43).toByte() }
      assertEquals(NativeCallWire.SendResult.SENT, a.sendAudio(NativeCallProtocol.audio(10, pcm)))
      val audio = bSink.until { it is ServerFrame.Audio && it.peer == "interop-a" } as ServerFrame.Audio
      assertArrayEquals(pcm, audio.pcm)
      assertEquals(me, audio.from)
      val payload = ObjectMapper().readTree("""{"nested":[null,1,"synthetic"],"ok":true}""")
      a.sendControl(NativeCallProtocol.emit("interop-custom", payload))
      val relay = bSink.until { it is ServerFrame.Relay && it.name == "interop-custom" } as ServerFrame.Relay
      assertEquals(payload, relay.payload)
      assertEquals(me, relay.from)

      replacement.connect(base, dev)
      replacementSink.until { it is ServerFrame.Hello }
      replacement.sendControl(NativeCallProtocol.join("interop-a", status))
      replacementSink.until { it is ServerFrame.CallState && it.members.map { m -> m.peer }.toSet() == setOf("interop-a", "interop-b") }
      a.close() // 古い同一 peer の退出で、新しい接続の参加者を消してはいけない。
      replacement.sendControl(NativeCallProtocol.update(status.copy(muted = true)))
      bSink.until { it is ServerFrame.CallState && it.members.any { m -> m.peer == "interop-a" && m.status.muted } }
      replacement.sendControl(NativeCallProtocol.update(status))
      replacement.sendAudio(NativeCallProtocol.audio(0, pcm)) // 復帰で seq が戻っても受けられる。
      val reset = bSink.until { it is ServerFrame.Audio && it.peer == "interop-a" && it.seq == 0L } as ServerFrame.Audio
      assertArrayEquals(pcm, reset.pcm)
      b.sendControl(NativeCallProtocol.kick("interop-a"))
      assertEquals(me, (replacementSink.until { it is ServerFrame.Kicked } as ServerFrame.Kicked).by)
      b.sendControl(NativeCallProtocol.leave())
      bSink.until { it is ServerFrame.CallState && it.members.isEmpty() }
    } finally {
      a.cancel()
      b.cancel()
      replacement.cancel()
      client.dispatcher.executorService.shutdownNow()
      client.connectionPool.evictAll()
      process.destroy()
      if (!process.waitFor(5, TimeUnit.SECONDS)) {
        process.destroyForcibly()
        process.waitFor(5, TimeUnit.SECONDS)
      }
      temp.deleteRecursively()
    }
  }

  private fun waitForHealth(base: String, process: Process) {
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
    while (System.nanoTime() < deadline) {
      if (!process.isAlive) throw AssertionError("Temporary test server exited")
      val connection = URL("$base/api/health").openConnection(Proxy.NO_PROXY) as HttpURLConnection
      connection.connectTimeout = 200
      connection.readTimeout = 200
      try {
        if (connection.responseCode == 200) return
      } catch (_: Exception) {
        // 一時サーバーの起動だけを待つ。本番の接続先を読んだり、再送したりしない。
      } finally {
        connection.disconnect()
      }
      Thread.sleep(25)
    }
    throw AssertionError("Temporary test server did not become ready")
  }
}
