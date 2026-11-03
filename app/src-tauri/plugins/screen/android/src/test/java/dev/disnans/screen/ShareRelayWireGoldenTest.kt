package dev.disnans.screen

import com.fasterxml.jackson.databind.ObjectMapper
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 送り手の JSON（[RelayWire.chunkJson]）が、固定の golden（resources/screen-relay/golden-v1.json）と一致するか。
 * 同じ golden を JS（nativeScreenRelayWire.test.ts）でも読み、受け手の組み立てまで確かめる。
 * データは合成の base64 だけ（画像・音声・ユーザー情報は含まない）。
 */
class ShareRelayWireGoldenTest {
  private val mapper = ObjectMapper()

  @Test fun chunkJsonMatchesGolden() {
    val text = javaClass.getResource("/screen-relay/golden-v1.json")!!.readText()
    val fx = mapper.readTree(text)
    assertEquals(1, fx.get("version").asInt())
    val frameId = fx.get("frameId").asLong()
    val data = fx.get("data").asText()
    assertTrue(RelayWire.isBase64(data))
    assertEquals(fx.get("chunkChars").asInt(), RelayLimits.CHUNK_CHARS)
    val want = fx.get("chunks")
    assertEquals(want.size(), (data.length + RelayLimits.CHUNK_CHARS - 1) / RelayLimits.CHUNK_CHARS)
    for (k in 0 until want.size()) {
      val w = want.get(k)
      val n = want.size()
      val got = mapper.readTree(RelayWire.chunkJson(frameId, w.get("i").asInt(), n, data))
      assertEquals(w.get("f").asLong(), got.get("f").asLong())
      assertEquals(w.get("i").asInt(), got.get("i").asInt())
      assertEquals(w.get("n").asInt(), got.get("n").asInt())
      val d = data.substring(w.get("from").asInt(), w.get("to").asInt())
      assertEquals(d, got.get("d").asText())
      assertEquals(w.get("to").asInt() - w.get("from").asInt(), got.get("d").asText().length)
      // 形: キーはこの 4 つだけ（受け手の parseChunk の形）
      assertEquals(setOf("f", "i", "n", "d"), got.fieldNames().asSequence().toSet())
    }
  }
}
