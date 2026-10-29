package dev.disnans.notifier

/**
 * 録音の読みを 800 サンプルにそろえる処理と、再生の書き切る処理（純粋な JVM。デバイスの録音・再生は使わない）。
 */
object NativeCallFramingTest {
  fun run() {
    // 1. 短い読みを足しても、フレームは順番どおりに欠けずに出る（捨てない）
    run {
      val source = ShortArray(3600) { (it % 30000 - 15000).toShort() }
      val acc = NativeFrameAccumulator(800)
      val got = ArrayList<Short>()
      var pos = 0
      for (size in listOf(1, 799, 800, 3, 1597, 240, 160)) {
        val chunk = source.copyOfRange(pos, pos + size)
        for (frame in acc.feed(chunk, size)) for (v in frame) got.add(v)
        pos += size
      }
      // 3600 サンプルのうち、そろったフレーム（4 つ = 3200）が出る。残り 400 は次の読みを待つ（捨てない）
      Check.eq(3200, got.size, "all full frames delivered, remainder kept for the next read")
      Check.that(got.indices.all { got[it] == source[it] }) { "order preserved" }
    }

    // 2. 読んだ数より後ろの値は使わない（配列の端を越えない）
    run {
      val acc = NativeFrameAccumulator(4)
      val frames = acc.feed(shortArrayOf(1, 2, 3, 4, 5, 6, 7, 8, 9), 6)
      Check.eq(1, frames.size, "one full frame from six samples")
      Check.that(frames[0].contentEquals(shortArrayOf(1, 2, 3, 4))) { "frame content" }
      Check.eq(0, acc.feed(shortArrayOf(), 0).size, "empty read gives nothing")
    }

    // 3. 書き込みが部分的・0 でも、塊は最後まで書かれ、待ちは空回りしない
    run {
      val block = ShortArray(800) { it.toShort() }
      val written = ArrayList<Short>()
      var calls = 0
      val sleeps = ArrayList<Long>()
      val result = NativePump.writeAll(
        block,
        write = { buf, off, len ->
          calls++
          when (calls % 3) {
            0 -> 0
            1 -> minOf(len, 100).also { n -> for (i in 0 until n) written.add(buf[off + i]) }
            else -> minOf(len, 37).also { n -> for (i in 0 until n) written.add(buf[off + i]) }
          }
        },
        running = { true },
        sleepMs = { ms -> sleeps.add(ms) },
      )
      Check.eq(PumpResult.Written, result, "whole block written")
      Check.eq(800, written.size, "every sample written once")
      Check.that(written.indices.all { written[it] == block[it] }) { "order preserved across partial writes" }
      Check.that(calls < 200) { "bounded calls: $calls" }
      Check.that(sleeps.size == calls / 3 && sleeps.all { it == NativePump.IDLE_WAIT_MS }) { "waits only on zero writes" }
    }

    // 4. 止められたら、残りは書かずに戻る（古い音を流し続けない）
    run {
      val block = ShortArray(800)
      var running = true
      var calls = 0
      val result = NativePump.writeAll(
        block,
        write = { _, _, len -> calls++; if (calls == 2) running = false; minOf(len, 100) },
        running = { running },
        sleepMs = {},
      )
      Check.eq(PumpResult.Stopped, result, "stopped mid-block")
      Check.that(calls <= 2) { "no writes after stop" }
    }

    // 5. 負の値は失敗（その理由の値を返す）
    run {
      val result = NativePump.writeAll(ShortArray(10), write = { _, _, _ -> -3 }, running = { true }, sleepMs = {})
      Check.eq(PumpResult.Failed(-3), result, "negative write fails")
    }

    // 6. 16 ビットの値とリトルエンディアンのバイトは往復で同じ
    run {
      val values = shortArrayOf(-32768, -1, 0, 1, 255, 256, 32767)
      Check.that(NativePcm.leToShorts(NativePcm.shortsToLe(values)).contentEquals(values)) { "LE round trip" }
    }
  }

  @JvmStatic fun main(args: Array<String>) {
    run()
    println("NativeCallFramingTest: ${Check.count} checks passed")
  }
}
