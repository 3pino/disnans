package dev.disnans.screen

import com.fasterxml.jackson.databind.ObjectMapper
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 代表色（ScreenQuantizer）が、JS の quantize.ts と同じ結果か（同じ golden: resources/screen-quantize/quantize-v1.json）。
 * 入力は golden と同じ整数の式（JS の synth と同じ）。データは合成だけ（画面の内容は含まない）。
 */
class ScreenQuantizerTest {
  private val mapper = ObjectMapper()

  /** golden の入力（JS の synth と同じ式） */
  private fun synth(kind: String, w: Int, h: Int): IntArray = IntArray(w * h) { i ->
    val r: Int
    val g: Int
    val b: Int
    val a: Int
    when (kind) {
      "mixed" -> {
        r = (i * 37) and 255
        g = (i * 91 + 7) and 255
        b = 160 + (i * 29) % 96
        a = if (i % 5 == 0) (i * 17) and 255 else 255
      }
      "blue" -> {
        r = (i * 7) and 63
        g = (i * 5) and 63
        b = 200 + (i * 3) % 56
        a = 255
      }
      else -> {
        r = 10
        g = 20
        b = 200
        a = if (i % 2 == 0) 255 else 128
      }
    }
    (a shl 24) or (r shl 16) or (g shl 8) or b
  }

  /** JS の fnv と同じ（RGBA の順のバイトで FNV-1a 32 bit） */
  private fun fnv(px: IntArray): String {
    var h = -2128831035 // 0x811c9dc5
    fun mix(b: Int) {
      h = (h xor (b and 0xff)) * 0x01000193
    }
    for (p in px) {
      mix(p shr 16)
      mix(p shr 8)
      mix(p)
      mix(p ushr 24)
    }
    return String.format("%08x", h)
  }

  private fun hex(values: IntArray): String = values.joinToString("") { String.format("%02x", it) }

  @Test fun matchesTheSharedGolden() {
    val fx = mapper.readTree(javaClass.getResource("/screen-quantize/quantize-v1.json")!!.readText())
    assertEquals(1, fx.get("version").asInt())
    for (c in fx.get("cases")) {
      val name = c.get("name").asText()
      val px = synth(c.get("kind").asText(), c.get("w").asInt(), c.get("h").asInt())
      assertEquals(name, c.get("palette").asText(), hex(ScreenQuantizer.buildPalette(px)))
      ScreenQuantizer.quantizeArgb(px)
      assertEquals(name, c.get("hash").asText(), fnv(px))
    }
  }

  @Test fun keepsAlpha() {
    val px = synth("mixed", 16, 8)
    val alpha = px.map { it ushr 24 }
    ScreenQuantizer.quantizeArgb(px)
    assertEquals(alpha, px.map { it ushr 24 })
  }

  @Test fun paletteIsBoundedAndDeterministic() {
    val px = synth("mixed", 160, 80)
    val a = ScreenQuantizer.buildPalette(px)
    assertTrue(a.size / 3 <= ScreenQuantizer.PALETTE_MAX)
    assertEquals(hex(a), hex(ScreenQuantizer.buildPalette(synth("mixed", 160, 80))))
  }

  @Test fun emptyAndFlatFrames() {
    assertEquals(0, ScreenQuantizer.buildPalette(IntArray(0)).size)
    val flat = synth("flat", 4, 4)
    ScreenQuantizer.quantizeArgb(flat)
    for (p in flat) assertEquals(listOf(10, 20, 200), listOf((p shr 16) and 0xff, (p shr 8) and 0xff, p and 0xff))
  }

  /** 旧い固定の格子（比べるための基準。コードには使わない） */
  private fun fixedGrid(px: IntArray): IntArray = IntArray(px.size) { i ->
    val p = px[i]
    val r = Math.round(((p shr 16 and 0xff) shr 5) * 255.0 / 7).toInt()
    val g = Math.round(((p shr 8 and 0xff) shr 5) * 255.0 / 7).toInt()
    val b = Math.round(((p and 0xff) shr 6) * 255.0 / 3).toInt()
    (p and -0x1000000) or (r shl 16) or (g shl 8) or b
  }

  private fun meanRgbError(a: IntArray, b: IntArray): Double {
    var sum = 0L
    var count = 0
    for (i in a.indices) {
      for (shift in intArrayOf(16, 8, 0)) {
        sum += Math.abs(((a[i] shr shift) and 0xff) - ((b[i] shr shift) and 0xff))
        count++
      }
    }
    return sum.toDouble() / count
  }

  @Test fun beatsTheFixedGridOnSeededRandomFrames() {
    // 種つきの乱数（JS の同じ式と同じ列）
    var s = 7L
    fun rnd(): Double {
      s = (s * 1664525L + 1013904223L) and 0xffffffffL
      return s / 4294967296.0
    }
    for (blueOnly in listOf(false, true)) {
      val src = IntArray(160 * 80) {
        val r = (rnd() * 256).toInt()
        val g = (rnd() * 256).toInt()
        val b = if (blueOnly) 160 + (rnd() * 96).toInt() else (rnd() * 256).toInt()
        (255 shl 24) or (r shl 16) or (g shl 8) or b
      }
      val mine = src.copyOf()
      ScreenQuantizer.quantizeArgb(mine)
      assertTrue(meanRgbError(src, mine) < meanRgbError(src, fixedGrid(src)))
    }
  }
}
