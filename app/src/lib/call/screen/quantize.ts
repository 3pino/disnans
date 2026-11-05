/**
 * 256 色の代表色（メディアンカット）。固定の 3・3・2 bit の格子と違い、この画面の色の分布から代表色を選ぶ。
 * 標本（最大 SAMPLE_MAX 画素）の色そのものを分割して代表色の平均にするので、よく出る色が代表になる。
 * ただし、標本に入らなかった色や 5 bit のキャッシュ（同じ段の中の色は、段の中心の色で近い代表を選ぶ）で
 * 少数の色は代表からずれることがある。色相を保つという保証はしない。実際の画面での見え方は未検証。
 *
 * 決定的で有界にしてある（Rust の screen_quantize.rs・Kotlin の ScreenQuantizer と同じ計算。同じ golden で確かめる）:
 * - 標本は最大 SAMPLE_MAX 画素（等間隔）。
 * - 分割は「いちばん広い軸を、標本の数の中央で二つに割る」。並べ替えは値と番号の全順序なので、結果は一つに決まる。
 * - 代表色の平均は整数の四捨五入。
 * - 画素から代表色へは、5 bit ずつ（32768 段階）のキャッシュで最も近い色を引く。1 枚あたりの計算は最大 32768 × 256。
 * アルファは変えない（RGB だけを書き換える）。
 */

export const PALETTE_MAX = 256;
export const SAMPLE_MAX = 8192;
const CELL_SHIFT = 3; // 8 段階ごと（5 bit）
const CELLS = 1 << 15;

/** 代表色を作る（RGB の並び・長さ 3×色数）。画素がなければ空 */
export function buildPalette(data: Uint8ClampedArray | Uint8Array): Uint8Array {
  const n = Math.floor(data.length / 4);
  if (n === 0) return new Uint8Array(0);
  const step = Math.max(1, Math.ceil(n / SAMPLE_MAX));
  const m = Math.ceil(n / step);
  const R = new Uint8Array(m);
  const G = new Uint8Array(m);
  const B = new Uint8Array(m);
  for (let k = 0, i = 0; k < m; k++, i += step) {
    R[k] = data[4 * i];
    G[k] = data[4 * i + 1];
    B[k] = data[4 * i + 2];
  }
  const ch = [R, G, B];
  const idx = new Int32Array(m);
  for (let k = 0; k < m; k++) idx[k] = k;

  type Box = { lo: number; hi: number; axis: number; range: number };
  const boxes: Box[] = [makeBox(0, m)];

  function makeBox(lo: number, hi: number): Box {
    let axis = 0;
    let range = -1;
    for (let c = 0; c < 3; c++) {
      let min = 255;
      let max = 0;
      const v = ch[c];
      for (let k = lo; k < hi; k++) {
        const x = v[idx[k]];
        if (x < min) min = x;
        if (x > max) max = x;
      }
      const r = max - min;
      if (r > range) {
        range = r;
        axis = c;
      }
    }
    return { lo, hi, axis, range };
  }

  while (boxes.length < PALETTE_MAX) {
    // いちばん広く（範囲×画素数が最大）、割れるもの。同点は先の箱
    let best = -1;
    let bestScore = -1;
    for (let b = 0; b < boxes.length; b++) {
      const box = boxes[b];
      if (box.hi - box.lo < 2 || box.range <= 0) continue;
      const score = box.range * (box.hi - box.lo);
      if (score > bestScore) {
        bestScore = score;
        best = b;
      }
    }
    if (best < 0) break;
    const box = boxes[best];
    const v = ch[box.axis];
    const part = Array.from(idx.subarray(box.lo, box.hi));
    part.sort((a, b) => v[a] - v[b] || a - b);
    for (let k = 0; k < part.length; k++) idx[box.lo + k] = part[k];
    const mid = box.lo + ((box.hi - box.lo) >> 1);
    boxes[best] = makeBox(box.lo, mid);
    boxes.push(makeBox(mid, box.hi));
  }

  const palette = new Uint8Array(boxes.length * 3);
  boxes.forEach((box, p) => {
    let sr = 0;
    let sg = 0;
    let sb = 0;
    const cnt = box.hi - box.lo;
    for (let k = box.lo; k < box.hi; k++) {
      const i = idx[k];
      sr += R[i];
      sg += G[i];
      sb += B[i];
    }
    palette[3 * p] = roundMean(sr, cnt);
    palette[3 * p + 1] = roundMean(sg, cnt);
    palette[3 * p + 2] = roundMean(sb, cnt);
  });
  return palette;
}

/** 整数の平均（四捨五入。半分は上）。cnt は 1 以上 */
function roundMean(sum: number, cnt: number): number {
  return Math.floor((2 * sum + cnt) / (2 * cnt));
}

/** 画素（RGBA）の RGB を、代表色のいちばん近いものに置き換える。アルファは変えない。その場で書き換える */
export function quantizeRgba(data: Uint8ClampedArray): void {
  const palette = buildPalette(data);
  const count = palette.length / 3;
  if (count === 0) return;
  const cache = new Int16Array(CELLS).fill(-1);
  for (let i = 0; i + 3 < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const key = ((r >> CELL_SHIFT) << 10) | ((g >> CELL_SHIFT) << 5) | (b >> CELL_SHIFT);
    let p = cache[key];
    if (p < 0) {
      p = nearest(palette, count, ((key >> 10) << CELL_SHIFT) + 4, (((key >> 5) & 31) << CELL_SHIFT) + 4, ((key & 31) << CELL_SHIFT) + 4);
      cache[key] = p;
    }
    data[i] = palette[3 * p];
    data[i + 1] = palette[3 * p + 1];
    data[i + 2] = palette[3 * p + 2];
  }
}

/** 代表色のうち、(r,g,b) にいちばん近いもの（同点は番号の小さいほう） */
function nearest(palette: Uint8Array, count: number, r: number, g: number, b: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let p = 0; p < count; p++) {
    const dr = palette[3 * p] - r;
    const dg = palette[3 * p + 1] - g;
    const db = palette[3 * p + 2] - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}
