package dev.disnans.notifier

import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** 本番の NativeCallAudioLifecycle をそのまま実行する。デバイスとスレッド起動失敗だけを差し替える。 */
object NativeCallAudioAdapterTest {
  private fun await(latch: CountDownLatch) = Check.that(latch.await(3, TimeUnit.SECONDS)) { "callback must arrive" }
  private class Record : NativeCallAudioLifecycle.Recorder {
    val starts = AtomicInteger()
    val closes = AtomicInteger()
    val stops = AtomicInteger()
    val reads = AtomicInteger()
    val queue = LinkedBlockingQueue<ShortArray>()
    val fail = ShortArray(1)
    override fun start() { starts.incrementAndGet() }
    override fun stopRead() { stops.incrementAndGet(); queue.offer(ShortArray(0)) }
    override fun release() { closes.incrementAndGet() }
    override fun read(buf: ShortArray, offset: Int, length: Int): Int {
      reads.incrementAndGet()
      val values = queue.take()
      if (values === fail) return -3
      val n = minOf(length, values.size)
      values.copyInto(buf, offset, 0, n)
      return n
    }
  }
  private class Player : NativeCallAudioLifecycle.Player {
    val closes = AtomicInteger()
    val writes = LinkedBlockingQueue<Int>()
    var onStart: () -> Unit = {}
    override fun start() = onStart()
    override fun write(buf: ShortArray, offset: Int, length: Int): Int = writes.take()
    override fun flush() = Unit
    override fun stop() { writes.offer(0) }
    override fun release() { closes.incrementAndGet() }
  }
  private class Harness(
    val record: Record = Record(), val player: Player = Player(),
    openRecord: (() -> NativeCallAudioLifecycle.Recorder)? = null,
    openPlayer: (() -> NativeCallAudioLifecycle.Player)? = null,
    failLaunch: Int = 0,
  ) {
    val opened = AtomicInteger()
    val launches = AtomicInteger()
    val sent = AtomicInteger()
    val failures = AtomicInteger()
    val frame = CountDownLatch(1)
    val run = NativeCallAudioLifecycle(NativeMixer(),
      { opened.incrementAndGet(); openRecord?.invoke() ?: record },
      { openPlayer?.invoke() ?: player },
      { _, _ -> sent.incrementAndGet(); frame.countDown() },
      { failures.incrementAndGet() },
      { System.nanoTime() / 1_000_000 },
      { name, body ->
        if (launches.incrementAndGet() == failLaunch) throw RejectedExecutionException()
        Thread(body, name).apply { isDaemon = true }.start()
      })
    fun close() {
      run.stop()
      Check.that(run.awaitReleased(3000)) { "all acquired handles must be released" }
      Check.eq(1, record.closes.get(), "recorder released once")
      Check.eq(1, player.closes.get(), "player released once")
    }
  }

  fun run() {
    // 初期ミュートは、デバイスを録音状態にせず、後の解除だけで録音を始める。
    Harness().let { h ->
      h.run.setCapture(false)
      Check.eq(null, h.run.start(), "initial muted start succeeds")
      Check.eq(0, h.record.starts.get(), "no recording for initial mute")
      Check.eq(0, h.record.reads.get(), "no reads for initial mute")
      h.record.queue.offer(ShortArray(800) { 20_000 })
      h.run.setCapture(true)
      await(h.frame)
      Check.eq(1, h.record.starts.get(), "unmute starts recording once")
      Check.eq("already_started", h.run.start(), "same run cannot open another pair")
      Check.eq(1, h.opened.get(), "one recorder")
      h.close()
      h.run.setCapture(true)
      h.run.stop()
      Check.eq(1, h.record.starts.get(), "no restart after stop")
      Check.eq(1, h.sent.get(), "no late frame")
    }
    Harness().let { h ->
      h.run.stop()
      Check.eq("stopped", h.run.start(), "pre-stopped run cannot start")
      Check.eq(0, h.opened.get(), "pre-stopped run opens nothing")
      Check.that(h.run.awaitReleased(0)) { "pre-stopped run already released" }
    }
    // recorder を取得する途中の停止。戻ってきた資源は録音も再生も開始せず返す。
    run {
      val entered = CountDownLatch(1)
      val proceed = CountDownLatch(1)
      val record = Record()
      val h = Harness(record = record, openRecord = { entered.countDown(); proceed.await(); record })
      val result = AtomicReference<String?>("pending")
      val thread = Thread { result.set(h.run.start()) }.apply { start() }
      await(entered)
      h.run.stop()
      Check.that(!h.run.awaitReleased(0)) { "pending open must still be tracked" }
      proceed.countDown()
      thread.join(3000)
      Check.eq("stopped", result.get(), "late open cancelled")
      Check.that(h.run.awaitReleased(3000)) { "late handle released" }
      Check.eq(0, record.starts.get(), "late handle never records")
      Check.eq(1, record.closes.get(), "late handle closed once")
      Check.eq(0, h.player.closes.get(), "player was never opened")
    }
    // 再生開始の失敗で、既に録音中のデバイスも両方確実に解放する。
    Harness().let { h ->
      h.player.onStart = { throw IllegalStateException("synthetic") }
      Check.eq("track_start", h.run.start(), "player start failure")
      h.close()
      Check.that(h.record.stops.get() >= 1) { "live recorder stopped on playback failure" }
      Check.eq(0, h.launches.get(), "no worker launched")
    }
    Harness(openPlayer = { throw IllegalStateException("synthetic") }).let { h ->
      Check.eq("track_init", h.run.start(), "player allocation failure")
      Check.that(h.run.awaitReleased(3000)) { "allocation failure released" }
      Check.eq(1, h.record.closes.get(), "earlier recorder released")
      Check.eq(0, h.record.starts.get(), "allocation failure never records")
    }
    for (failedThread in 1..2) Harness(failLaunch = failedThread).let { h ->
      Check.eq("audio_thread_start", h.run.start(), "thread launch failure")
      h.close()
      Check.eq(0, h.sent.get(), "failed startup emits nothing")
    }
    // init の途中で stop が競合しても、stop が戻った後に pump を新設しない。
    run {
      val entered = CountDownLatch(1)
      val proceed = CountDownLatch(1)
      val h = Harness()
      h.player.onStart = { entered.countDown(); proceed.await() }
      val result = AtomicReference<String?>("pending")
      val starting = Thread { result.set(h.run.start()) }.apply { start() }
      await(entered)
      val stopping = Thread { h.run.stop() }.apply { start() }
      val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3)
      while (stopping.state != Thread.State.BLOCKED && System.nanoTime() < deadline) Thread.yield()
      Check.eq(Thread.State.BLOCKED, stopping.state, "stop intent registered while init holds its handoff lock")
      proceed.countDown()
      starting.join(3000); stopping.join(3000)
      Check.eq("stopped", result.get(), "in-flight initialization cancelled")
      Check.eq(0, h.launches.get(), "cancelled initialization starts no pump threads")
      h.close()
    }
    Harness().let { h ->
      Check.eq(null, h.run.start(), "normal start")
      h.record.queue.offer(h.record.fail)
      Check.that(h.run.awaitReleased(3000)) { "driver failure releases both devices" }
      Check.eq(1, h.failures.get(), "one failure callback")
      h.close()
    }
    println("NativeCallAudioAdapterTest: production lifetime, cancellation and failure cleanup passed")
  }
}
