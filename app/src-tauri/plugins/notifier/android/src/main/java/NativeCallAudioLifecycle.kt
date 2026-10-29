package dev.disnans.notifier

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Android と JVM の試験が同じ資源の取得・引き渡し・停止・解放を使う。1 回だけ開始できる。 */
internal class NativeCallAudioLifecycle(
  private val mixer: NativeMixer,
  private val openRecorder: () -> Recorder,
  private val openPlayer: () -> Player,
  private val sender: (Long, ByteArray) -> Unit,
  private val onFailure: (String) -> Unit,
  private val nowMs: () -> Long,
  private val launch: (String, () -> Unit) -> Unit = { name, body -> Thread(body, name).apply { isDaemon = true }.start() },
) : AudioRun {
  interface Recorder : NativeCallPump.Recorder {
    fun start()
    fun release()
  }
  interface Player : NativeCallPump.Player {
    fun start()
    fun release()
  }
  class Failure(val code: String) : Exception(code)
  private class Cancelled : Exception()
  private class Lease<T>(val value: T, private val close: (T) -> Unit) {
    var released = false
      private set
    fun release(): Boolean {
      if (released) return true
      released = true
      return try { close(value); true } catch (_: Exception) { false }
    }
  }

  private val lock = Any()
  // stop は遅い open の終了を待たず、先に意図を無効にする。
  private val terminal = AtomicBoolean(false)
  private val notified = AtomicBoolean(false)
  private val released = CountDownLatch(1)
  private var attempted = false
  private var initializing = false
  private var captureIntent = true
  private var volume = 1.0
  private var record: Lease<Recorder>? = null
  private var player: Lease<Player>? = null
  private var captureLaunched = false
  private var playLaunched = false
  private var pump: NativeCallPump? = null
  private var stopApplied = false
  private var cleanupFailed = false

  override fun start(): String? {
    synchronized(lock) {
      if (terminal.get()) return "stopped"
      if (attempted) return "already_started"
      attempted = true
      initializing = true
    }
    var success = false
    var stage = "record_init"
    try {
      checkIntent()
      val rec = Lease(openRecorder()) { it.release() }
      synchronized(lock) { record = rec }
      checkIntent()
      stage = "track_init"
      val out = Lease(openPlayer()) { it.release() }
      synchronized(lock) { player = out }
      synchronized(lock) {
        checkIntent()
        val p = NativeCallPump(rec.value, out.value, sender = { seq, pcm ->
          // stop が戻ったあとに、未送信のフレームを外へ渡さない。
          synchronized(lock) { if (!terminal.get() && captureIntent) sender(seq, pcm) }
        }, onFailure = { fail(it) })
        pump = p
        p.setMicVolume(volume)
        p.setCapture(captureIntent)
        stage = "record_start"
        if (captureIntent) rec.value.start()
        checkIntent()
        stage = "track_start"
        out.value.start()
        checkIntent()
        p.markRunning()
        stage = "audio_thread_start"
        captureLaunched = true
        try {
          launch("disnans-native-mic") {
            try { p.captureLoop(nowMs) } finally { finishRecorder(rec) }
          }
        } catch (t: Throwable) { captureLaunched = false; throw t }
        checkIntent()
        playLaunched = true
        try {
          launch("disnans-native-play") {
            try { p.playLoop(mixer) } finally { finishPlayer(out) }
          }
        } catch (t: Throwable) { playLaunched = false; throw t }
        checkIntent()
        success = true
      }
      return null
    } catch (_: Cancelled) {
      return "stopped"
    } catch (e: Failure) {
      return e.code.takeIf { it.matches(Regex("[a-z_]{1,32}")) } ?: "audio_start"
    } catch (_: SecurityException) {
      return "permission_lost"
    } catch (_: Exception) {
      return stage
    } finally {
      synchronized(lock) {
        initializing = false
        if (!success || terminal.get()) {
          terminal.set(true)
          stopLocked()
        }
        completeLocked()
      }
    }
  }

  override fun stop() {
    terminal.set(true)
    synchronized(lock) {
      stopLocked()
      completeLocked()
    }
  }

  override fun setCapture(enabled: Boolean) {
    var error: String? = null
    synchronized(lock) {
      if (terminal.get()) return
      captureIntent = enabled
      val p = pump ?: return
      try {
        if (enabled) {
          record?.value?.start()
          p.setCapture(true)
        } else {
          p.setCapture(false)
        }
      } catch (_: SecurityException) { error = "permission_lost" }
      catch (_: Exception) { error = "record_start" }
    }
    error?.let { fail(it) }
  }

  override fun setMicVolume(volume: Double) = synchronized(lock) {
    this.volume = NativePcm.clampVolume(volume, NativePcm.MIC_VOLUME_MAX)
    pump?.setMicVolume(this.volume)
    Unit
  }

  override fun awaitReleased(timeoutMs: Long): Boolean =
    released.await(timeoutMs, TimeUnit.MILLISECONDS) && synchronized(lock) { !cleanupFailed }

  override fun audioCounters(): Map<String, Long> = synchronized(lock) {
    val m = pump?.metrics() ?: return emptyMap()
    mapOf("captureReads" to m.captureReads, "captureSamples" to m.captureSamples,
      "captureFramed" to m.captureFramed, "captureGated" to m.captureGated,
      "captureSendAttempts" to m.captureSendAttempts, "playSamples" to m.playSamples,
      "playPartial" to m.playPartial, "playErrors" to m.playErrors)
  }

  private fun checkIntent() { if (terminal.get()) throw Cancelled() }

  /** lock の中。スレッドに渡していない資源は、この場で必ず解放する。 */
  private fun stopLocked() {
    if (!stopApplied) {
      stopApplied = true
      try { pump?.stop() } catch (_: Exception) { cleanupFailed = true }
      // pump の生成前に停止した場合も、取得済みのデバイスを止める。
      if (pump == null) {
        try { record?.value?.stopRead() } catch (_: Exception) { cleanupFailed = true }
        try { player?.value?.flush() } catch (_: Exception) { cleanupFailed = true }
        try { player?.value?.stop() } catch (_: Exception) { cleanupFailed = true }
      }
    }
    if (!captureLaunched) record?.let { if (!it.release()) cleanupFailed = true }
    if (!playLaunched) player?.let { if (!it.release()) cleanupFailed = true }
  }

  private fun finishRecorder(rec: Lease<Recorder>) = synchronized(lock) {
    if (!rec.release()) cleanupFailed = true
    completeLocked()
  }

  private fun finishPlayer(out: Lease<Player>) = synchronized(lock) {
    if (!out.release()) cleanupFailed = true
    completeLocked()
  }

  private fun completeLocked() {
    if (terminal.get() && !initializing && record?.released != false && player?.released != false) released.countDown()
  }

  private fun fail(code: String) {
    stop()
    if (notified.compareAndSet(false, true)) onFailure(code)
  }
}
