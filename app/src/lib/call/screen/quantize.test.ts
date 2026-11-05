import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PALETTE_MAX, buildPalette, quantizeRgba } from './quantize';

// 同じ golden を Kotlin（ScreenQuantizerTest）でも読む。正は Android 側のリソース（生成は一度だけ行った）
const GOLDEN = new URL('../../../../src-tauri/plugins/screen/android/src/test/resources/screen-quantize/quantize-v1.json', import.meta.url);

/** golden の入力（整数だけの式。Kotlin の試験と同じ） */
function synth(kind: string, w: number, h: number): Uint8ClampedArray {
  const n = w * h;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    let r: number, g: number, b: number, a: number;
    if (kind === 'mixed') {
      r = (i * 37) & 255;
      g = (i * 91 + 7) & 255;
      b = 160 + ((i * 29) % 96);
      a = i % 5 === 0 ? (i * 17) & 255 : 255;
    } else if (kind === 'blue') {
      r = (i * 7) & 63;
      g = (i * 5) & 63;
      b = 200 + ((i * 3) % 56);
      a = 255;
    } else {
      r = 10;
      g = 20;
      b = 200;
      a = i % 2 === 0 ? 255 : 128;
    }
    out.set([r, g, b, a], i * 4);
  }
  return out;
}

function fnv(bytes: Uint8ClampedArray): string {
  let h = 0x811c9dc5;
  for (const x of bytes) {
    h ^= x;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const hex = (bytes: Uint8Array) => [...bytes].map((x) => x.toString(16).padStart(2, '0')).join('');

type Golden = { version: number; cases: { name: string; kind: string; w: number; h: number; palette: string; hash: string }[] };
const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Golden;

/** 旧い固定の 3・3・2 bit の格子（旧 applyColorMode と同じ段階。比べるための基準。コードには使わない） */
function fixedGrid(data: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data);
  for (let i = 0; i + 3 < out.length; i += 4) {
    out[i] = Math.round(((out[i] >> 5) * 255) / 7);
    out[i + 1] = Math.round(((out[i + 1] >> 5) * 255) / 7);
    out[i + 2] = Math.round(((out[i + 2] >> 6) * 255) / 3);
  }
  return out;
}

/** 平均の絶対誤差（RGB の 3 チャンネル）。アルファは数えない */
function meanRgbError(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      sum += Math.abs(a[i + c] - b[i + c]);
      count++;
    }
  }
  return sum / count;
}

describe('quantize（代表色の 256 色）', () => {
  it('Kotlin と同じ golden: 代表色と出力の指紋が一致する', () => {
    expect(golden.version).toBe(1);
    for (const c of golden.cases) {
      const px = synth(c.kind, c.w, c.h);
      expect(hex(buildPalette(px)), c.name).toBe(c.palette);
      quantizeRgba(px);
      expect(fnv(px), c.name).toBe(c.hash);
    }
  });

  it('アルファは変えない（RGB だけを書き換える）', () => {
    const px = synth('mixed', 16, 8);
    const alpha = px.filter((_, i) => i % 4 === 3);
    quantizeRgba(px);
    expect(px.filter((_, i) => i % 4 === 3)).toEqual(alpha);
  });

  it('代表色は最大 PALETTE_MAX 色。同じ入力なら、何度でも同じ結果', () => {
    const px = synth('mixed', 160, 80);
    const a = buildPalette(px);
    expect(a.length / 3).toBeLessThanOrEqual(PALETTE_MAX);
    expect(buildPalette(synth('mixed', 160, 80))).toEqual(a);
  });

  it('画素がなければ何もしない。単色の画面は、その色だけになる', () => {
    expect(buildPalette(new Uint8ClampedArray(0)).length).toBe(0);
    const empty = new Uint8ClampedArray(0);
    quantizeRgba(empty);
    expect(empty.length).toBe(0);
    const flat = synth('flat', 4, 4);
    quantizeRgba(flat);
    for (let i = 0; i < flat.length; i += 4) expect([flat[i], flat[i + 1], flat[i + 2]]).toEqual([10, 20, 200]);
  });

  it('合成の青っぽい画面は、固定の格子より平均の誤差が小さい（色相の保証ではない）', () => {
    const src = synth('blue', 64, 32);
    const mine = new Uint8ClampedArray(src);
    quantizeRgba(mine);
    const grid = fixedGrid(src);
    expect(meanRgbError(src, mine)).toBeLessThan(meanRgbError(src, grid));
  });

  it('一様な乱数の画面（決まった種）でも、固定の格子より誤差が小さい', () => {
    // 種つきの乱数（テストごとに同じ）。青寄りの画面も同じ
    let s = 7;
    const rnd = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (const blueOnly of [false, true]) {
      const src = new Uint8ClampedArray(160 * 80 * 4);
      for (let i = 0; i < 160 * 80; i++) {
        src.set([Math.floor(rnd() * 256), Math.floor(rnd() * 256), blueOnly ? 160 + Math.floor(rnd() * 96) : Math.floor(rnd() * 256), 255], i * 4);
      }
      const mine = new Uint8ClampedArray(src);
      quantizeRgba(mine);
      expect(meanRgbError(src, mine)).toBeLessThan(meanRgbError(src, fixedGrid(src)));
    }
  });

  it('最悪の入力（すべての画素が違う色）の 720p・20 fps の計算が有界（代表色は上限以内、時間は大きく余裕のある上限以内）', () => {
    // 種つきの乱数（すべて違う色になりやすい）。時間の上限は、通常の CPU で 1 枚 100 ms を超えないほどの余裕
    let s = 11;
    const w = 1280;
    const h = 720;
    const px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      px.set([s & 255, (s >>> 8) & 255, (s >>> 16) & 255, 255], i * 4);
    }
    const t0 = performance.now();
    quantizeRgba(px);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(2000);
    expect(buildPalette(px).length / 3).toBeLessThanOrEqual(PALETTE_MAX);
  });

  it('大きい画面でも、標本の上限で計算が有界（1920×1080 でも完了し、色数は上限以内）', () => {
    const w = 1920;
    const h = 1080;
    const px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) px.set([(i * 13) & 255, (i * 7) & 255, 180 + ((i * 3) & 63), 255], i * 4);
    const palette = buildPalette(px);
    expect(palette.length / 3).toBeLessThanOrEqual(PALETTE_MAX);
    quantizeRgba(px);
    expect(px.length).toBe(w * h * 4);
  });
});
