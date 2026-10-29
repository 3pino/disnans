package dev.disnans.notifier

/**
 * 再生の並べ方・ゲイン・上限・無音の判定の試験（Android に依存しない）。
 * 期待値は pure.ts の式から計算した数（例: lead 0.12s は 1920 サンプル）。
 */
object NativeCallMixerTest {
  private fun frame(v: Double): ShortArray = ShortArray(NativePcm.FRAME) { NativePcm.floatToInt16(floatArrayOf(v.toFloat()))[0] }
  private fun block(m: NativeMixer): ShortArray = ShortArray(NativePcm.FRAME).also { m.mixBlock(it) }

  fun run() {
    // 1. 最初の塊は lead（0.12s = 1920 サンプル）の位置に置かれる。前の塊は無音
    run {
      val m = NativeMixer()
      m.addPeer("a")
      Check.eq(NativeMixer.Accept.ACCEPTED, m.accept("a", frame(0.5)), "accept first")
      val b0 = block(m)
      val b1 = block(m)
      Check.that(b0.all { it.toInt() == 0 } && b1.all { it.toInt() == 0 }) { "lead must stay silent" }
      val b2 = block(m) // 1600..2399: 320 サンプル目から音
      Check.eq(0, b2[319].toInt(), "silence before lead boundary")
      Check.that(b2[320].toInt() != 0) { "audio should start at sample 1920" }
    }

    // 2. 知らない相手は受けない
    run {
      val m = NativeMixer()
      Check.eq(NativeMixer.Accept.UNKNOWN_PEER, m.accept("nobody", frame(0.1)), "unknown peer")
    }

    // 3. 先に溜まりすぎたら捨てる（maxLead 0.6s。11 個目から）
    run {
      val m = NativeMixer()
      m.addPeer("a")
      val results = (1..12).map { m.accept("a", frame(0.1)) }
      Check.eq(10, results.count { it == NativeMixer.Accept.ACCEPTED }, "accepted before maxLead")
      Check.eq(NativeMixer.Accept.LATE, results[10], "11th frame is late")
    }

    // 4. 二人の音を足す（ゲインつき）。ゲイン 0 は無音
    run {
      val m = NativeMixer()
      m.addPeer("a")
      m.addPeer("b")
      m.setGain("a", 1.0)
      m.setGain("b", 0.0)
      m.accept("a", frame(0.25))
      m.accept("b", frame(0.5))
      repeat(2) { block(m) }
      val mix = block(m)
      // 0.25 だけが出る（b は 0 倍）
      val expected = NativePcm.floatToInt16(floatArrayOf(0.25f))[0].toInt()
      Check.eq(expected, mix[400].toInt(), "gain 0 silences b")
    }

    // 5. 上限: 足した音は上限を超えない（-6dB ≒ 0.501）
    run {
      val m = NativeMixer()
      m.addPeer("a")
      m.addPeer("b")
      m.setLimit(-6.0)
      m.accept("a", frame(0.9))
      m.accept("b", frame(0.9))
      repeat(2) { block(m) }
      val mix = block(m)
      val ceiling = NativePcm.dbToLinear(-6.0)
      val maxAbs = mix.maxOf { Math.abs(it.toInt()) }
      Check.that(maxAbs <= Math.round(ceiling * 32767).toInt() + 2) { "sum above ceiling: $maxAbs" }
    }

    // 6. 上限をオフにすると、足し合わせた音はそのまま（32767 で止まる）
    run {
      val m = NativeMixer()
      m.addPeer("a")
      m.addPeer("b")
      m.setLimit(null)
      m.accept("a", frame(0.9))
      m.accept("b", frame(0.9))
      repeat(2) { block(m) }
      val mix = block(m)
      Check.that(mix.maxOf { it.toInt() } >= 32000) { "without limit the sum passes through" }
    }

    // 7. 途切れたあとの再開は、また lead を置く（空になったら、ためてから鳴らす）
    run {
      val m = NativeMixer()
      m.addPeer("a")
      m.accept("a", frame(0.3))
      repeat(10) { block(m) } // 0.5s 空
      Check.eq(NativeMixer.Accept.ACCEPTED, m.accept("a", frame(0.3)), "after underrun")
      val silent = block(m)
      Check.that(silent.all { it.toInt() == 0 }) { "after underrun the new block waits for lead" }
    }

    // 8. 相手を外すと、その音は消え、もう受けない
    run {
      val m = NativeMixer()
      m.addPeer("a")
      m.accept("a", frame(0.4))
      m.removePeer("a")
      Check.eq(0, m.peerCount(), "removed")
      Check.eq(NativeMixer.Accept.UNKNOWN_PEER, m.accept("a", frame(0.4)), "after removal")
    }

    // 9. 無音の判定（RMS ≤ 0.004 が 500ms 続いたら送らない）
    run {
      val gate = NativeSilenceGate()
      val loud = FloatArray(800) { 0.1f }
      val quiet = FloatArray(800) { 0.0f }
      Check.that(gate.shouldSend(loud, 0)) { "loud sends" }
      Check.that(gate.shouldSend(quiet, 100)) { "quiet within hold sends" }
      Check.that(!gate.shouldSend(quiet, 600)) { "quiet after hold does not" }
      Check.that(gate.shouldSend(loud, 700)) { "loud again sends" }
      Check.that(gate.shouldSend(quiet, 1100)) { "quiet 400ms later sends" }
      Check.that(!gate.shouldSend(quiet, 1300)) { "quiet 600ms later does not" }
    }

    // 11. 800 以外の長さの塊は、その長さの時間だけ進む（400 の次の塊は、400 サンプル後から鳴る）
    run {
      val m = NativeMixer()
      m.addPeer("a")
      val short = ShortArray(400) { NativePcm.floatToInt16(floatArrayOf(0.25f))[0] }
      val long = ShortArray(800) { NativePcm.floatToInt16(floatArrayOf(0.5f))[0] }
      Check.eq(NativeMixer.Accept.ACCEPTED, m.accept("a", short), "400-sample packet accepted")
      Check.eq(NativeMixer.Accept.ACCEPTED, m.accept("a", long), "800-sample packet accepted")
      block(m)
      block(m)
      val b2 = block(m) // 1600..2399: 第一の塊は 1920..2319、次の塊は 2320 から
      val lowEnd = NativePcm.floatToInt16(floatArrayOf(0.25f))[0].toInt()
      val highEnd = NativePcm.floatToInt16(floatArrayOf(0.5f))[0].toInt()
      Check.that(Math.abs(b2[719].toInt() - lowEnd) <= 2) { "last sample of the 400 packet at 2319: ${b2[719]}" }
      Check.that(Math.abs(b2[720].toInt() - highEnd) <= 2) { "first sample of the 800 packet at 2320: ${b2[720]}" }
    }

    // 12. 空の塊は受けない。リングに収まらない長さも受けない
    run {
      val m = NativeMixer()
      m.addPeer("a")
      Check.eq(NativeMixer.Accept.EMPTY, m.accept("a", ShortArray(0)), "empty packet rejected")
      Check.eq(NativeMixer.Accept.TOO_LONG, m.accept("a", ShortArray(20_000)), "too long packet rejected")
    }

    // 10. 上限の値（クランプ）と音量の値
    run {
      Check.near(-6.0, NativePcm.clampLimitDb(null), 0.0, "null limit -> default")
      Check.near(-6.0, NativePcm.clampLimitDb(Double.NaN), 0.0, "NaN limit -> default")
      Check.near(-18.0, NativePcm.clampLimitDb(-99.0), 0.0, "min clamp")
      Check.near(-3.0, NativePcm.clampLimitDb(5.0), 0.0, "max clamp")
      Check.near(1.0, NativePcm.clampVolume(null, NativePcm.MIC_VOLUME_MAX), 0.0, "null volume -> 1")
      Check.near(2.0, NativePcm.clampVolume(9.0, NativePcm.MIC_VOLUME_MAX), 0.0, "volume max clamp")
      Check.near(0.0, NativePcm.clampVolume(-1.0, NativePcm.OUT_VOLUME_MAX), 0.0, "volume min clamp")
    }
  }

  @JvmStatic fun main(args: Array<String>) {
    run()
    println("NativeCallMixerTest: ${Check.count} checks passed")
  }
}
