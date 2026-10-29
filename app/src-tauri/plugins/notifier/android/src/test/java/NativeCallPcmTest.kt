package dev.disnans.notifier

/**
 * web 版（pure.ts）の出力と照合する試験（golden-v1.json は pure.ts から作った値）。
 * 実行は native-tests の nativeCallTest（手順は docs/design/android-call.md）。
 */
object NativeCallPcmTest {
  fun run() {
    val g = Golden.root

    // 定数が web 版と同じ
    val c = g["constants"]
    Check.eq(c["RELAY_RATE"].asInt(), NativePcm.RATE, "rate")
    Check.eq(c["RELAY_FRAME"].asInt(), NativePcm.FRAME, "frame")
    Check.near(c["RELAY_LEAD"].asDouble(), NativePcm.LEAD_SEC, 0.0, "lead")
    Check.near(c["RELAY_MAX_LEAD"].asDouble(), NativePcm.MAX_LEAD_SEC, 0.0, "maxLead")
    Check.eq(c["RELAY_HOLD_MS"].asLong(), NativePcm.HOLD_MS, "hold")
    Check.near(c["RELAY_SILENCE"].asDouble(), NativePcm.SILENCE_RMS, 0.0, "silence")
    Check.eq(c["LIMIT_LOOKAHEAD_MS"].asInt(), NativePcm.LIMIT_LOOKAHEAD_MS, "lookahead")
    Check.eq(c["LIMIT_ATTACK_MS"].asInt(), NativePcm.LIMIT_ATTACK_MS, "attack")
    Check.eq(c["LIMIT_RELEASE_MS"].asInt(), NativePcm.LIMIT_RELEASE_MS, "release")
    Check.near(c["LIMIT_DB_DEFAULT"].asDouble(), NativePcm.LIMIT_DB_DEFAULT, 0.0, "limit default")

    // float <-> int16（切り捨て・負と正で倍率が違う）
    val fi = g["floatToInt16"]
    val got = NativePcm.floatToInt16(fi.floats("input"))
    val want = fi.shorts("output")
    for (i in want.indices) Check.eq(want[i].toInt(), got[i].toInt(), "floatToInt16[$i]")
    val ti = g["int16ToFloat"]
    val gf = NativePcm.int16ToFloat(ti.shorts("input"))
    val wf = ti.floats("output")
    for (i in wf.indices) Check.near(wf[i].toDouble(), gf[i].toDouble(), 1e-7, "int16ToFloat[$i]")

    // base64: 送る形と一致（2136 文字・パディングつき）、受けるときの判定
    val b = g["base64"]
    val samples = b.shorts("samples")
    val encoded = NativePcm.pcmToBase64(samples)
    Check.eq(b["base64"].asText(), encoded, "base64 encode")
    Check.eq(2136, encoded.length, "frame base64 length")
    for (case in b["decodeCases"]) {
      val raw = case["rawInput"].asText()
      val ours = NativePcm.base64ToPcm(raw)
      Check.eq(case["jsOk"].asBoolean(), ours != null, "decode ok for len=${raw.length}")
      if (case["jsOk"].asBoolean()) {
        val want2 = case["jsSamples"]
        if (want2 != null && !want2.isNull) {
          Check.eq(want2.size(), ours!!.size, "decoded size")
          for (i in ours.indices) Check.eq(want2[i].asInt(), ours[i].toInt(), "decoded[$i]")
        }
      }
    }
    Check.eq(null, NativePcm.base64ToPcm(null), "null input")
    Check.eq(null, NativePcm.base64ToPcm("A".repeat(8196)), "over max length")

    // RMS
    val rmsIn = g["rms"].floats("input")
    Check.near(g["rms"]["output"].asDouble(), NativePcm.rms(rmsIn), 1e-6, "rms")

    // ピーク制限: 4 つの上限で、チャンクをまたいで同じ出力
    for (cs in g["limiter"]["cases"]) {
      val db = cs["db"].asDouble()
      val lim = NativePeakLimiter(NativePcm.RATE, db)
      val sig = g["limiter"].floats("input")
      var off = 0
      for (chunk in cs["chunks"]) {
        val n = chunk.size()
        val piece = sig.copyOfRange(off, off + n)
        val out = lim.process(piece)
        for (i in 0 until n) Check.near(chunk[i].asDouble(), out[i].toDouble(), 2e-6, "limiter db=$db chunk@${off + i}")
        off += n
      }
      // 上限を超えない（ceiling 以下）
      val ceiling = NativePcm.dbToLinear(db)
      for (chunk in cs["chunks"]) for (v in chunk) Check.that(Math.abs(v.asDouble()) <= ceiling + 1e-6) { "limiter output above ceiling db=$db" }
    }

    // ジッター（scheduleFrame）: 同じ到着の時刻で、同じ時刻・捨てる判定
    val js = NativeJitterSchedule()
    for (t in g["schedule"]["trace"]) {
      val at = js.schedule(t["now"].asDouble(), t["dur"].asDouble())
      val want3 = t["at"]
      if (want3 == null || want3.isNull) Check.eq(null, at, "schedule drop at now=${t["now"]}")
      else Check.near(want3.asDouble(), at ?: Double.NaN, 1e-9, "schedule at now=${t["now"]}")
    }
  }

  @JvmStatic fun main(args: Array<String>) {
    run()
    println("NativeCallPcmTest: ${Check.count} checks passed")
  }
}
