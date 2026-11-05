package dev.disnans.screen

import kotlin.math.max

/**
 * 256 色の代表色（メディアンカット）。JS の app/src/lib/call/screen/quantize.ts と同じ計算（同じ golden で確かめる）。
 * 決定的で有界: 標本は最大 SAMPLE_MAX 画素、分割は広い軸の中央、平均は整数の四捨五入、
 * 画素から代表色へは 5 bit ずつのキャッシュ（32768 × 256 まで）。アルファは変えない。
 * Android に依存しない純粋な計算（JVM の単体試験で動く）。
 */
object ScreenQuantizer {
  const val PALETTE_MAX = 256
  const val SAMPLE_MAX = 8192
  private const val CELLS = 1 shl 15

  /** 代表色（RGB の並び・長さ 3×色数）。画素がなければ空 */
  fun buildPalette(px: IntArray): IntArray {
    val n = px.size
    if (n == 0) return IntArray(0)
    val step = max(1, (n + SAMPLE_MAX - 1) / SAMPLE_MAX)
    val m = (n + step - 1) / step
    val r = IntArray(m)
    val g = IntArray(m)
    val b = IntArray(m)
    var i = 0
    for (k in 0 until m) {
      val p = px[i]
      r[k] = (p shr 16) and 0xff
      g[k] = (p shr 8) and 0xff
      b[k] = p and 0xff
      i += step
    }
    val ch = arrayOf(r, g, b)
    val idx = IntArray(m) { it }

    val boxes = ArrayList<Box>()
    boxes.add(makeBox(ch, idx, 0, m))
    while (boxes.size < PALETTE_MAX) {
      // いちばん広く（範囲×画素数が最大）、割れるもの。同点は先の箱
      var best = -1
      var bestScore = -1L
      for (bi in boxes.indices) {
        val box = boxes[bi]
        if (box.hi - box.lo < 2 || box.range <= 0) continue
        val score = box.range.toLong() * (box.hi - box.lo)
        if (score > bestScore) {
          bestScore = score
          best = bi
        }
      }
      if (best < 0) break
      val box = boxes[best]
      val v = ch[box.axis]
      val part = (box.lo until box.hi).map { idx[it] }.sortedWith(compareBy<Int>({ v[it] }, { it }))
      for (q in part.indices) idx[box.lo + q] = part[q]
      val mid = box.lo + ((box.hi - box.lo) shr 1)
      boxes[best] = makeBox(ch, idx, box.lo, mid)
      boxes.add(makeBox(ch, idx, mid, box.hi))
    }

    val palette = IntArray(boxes.size * 3)
    for (p in boxes.indices) {
      val box = boxes[p]
      var sr = 0L
      var sg = 0L
      var sb = 0L
      val cnt = box.hi - box.lo
      for (k in box.lo until box.hi) {
        val s = idx[k]
        sr += r[s]
        sg += g[s]
        sb += b[s]
      }
      palette[3 * p] = roundMean(sr, cnt)
      palette[3 * p + 1] = roundMean(sg, cnt)
      palette[3 * p + 2] = roundMean(sb, cnt)
    }
    return palette
  }

  /** 画素（ARGB）の RGB を代表色のいちばん近いものに置き換える。アルファは変えない。その場で書き換える */
  fun quantizeArgb(px: IntArray) {
    val palette = buildPalette(px)
    val count = palette.size / 3
    if (count == 0) return
    val cache = IntArray(CELLS) { -1 }
    for (i in px.indices) {
      val p = px[i]
      val r = (p shr 16) and 0xff
      val g = (p shr 8) and 0xff
      val b = p and 0xff
      val key = ((r shr 3) shl 10) or ((g shr 3) shl 5) or (b shr 3)
      var q = cache[key]
      if (q < 0) {
        q = nearest(palette, count, ((key shr 10) shl 3) + 4, (((key shr 5) and 31) shl 3) + 4, ((key and 31) shl 3) + 4)
        cache[key] = q
      }
      px[i] = (p and -0x1000000) or (palette[3 * q] shl 16) or (palette[3 * q + 1] shl 8) or palette[3 * q + 2]
    }
  }

  private class Box(val lo: Int, val hi: Int, val axis: Int, val range: Int)

  private fun makeBox(ch: Array<IntArray>, idx: IntArray, lo: Int, hi: Int): Box {
    var axis = 0
    var range = -1
    for (c in 0 until 3) {
      var min = 255
      var max = 0
      val v = ch[c]
      for (k in lo until hi) {
        val x = v[idx[k]]
        if (x < min) min = x
        if (x > max) max = x
      }
      if (max - min > range) {
        range = max - min
        axis = c
      }
    }
    return Box(lo, hi, axis, range)
  }

  /** 整数の平均（四捨五入。半分は上）。cnt は 1 以上 */
  private fun roundMean(sum: Long, cnt: Int): Int = ((2 * sum + cnt) / (2L * cnt)).toInt()

  /** 代表色のうち、(r,g,b) にいちばん近いもの（同点は番号の小さいほう） */
  private fun nearest(palette: IntArray, count: Int, r: Int, g: Int, b: Int): Int {
    var best = 0
    var bestD = Long.MAX_VALUE
    for (p in 0 until count) {
      val dr = (palette[3 * p] - r).toLong()
      val dg = (palette[3 * p + 1] - g).toLong()
      val db = (palette[3 * p + 2] - b).toLong()
      val d = dr * dr + dg * dg + db * db
      if (d < bestD) {
        bestD = d
        best = p
      }
    }
    return best
  }
}
