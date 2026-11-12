// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  COLOR_MODES,
  FPS_OPTIONS,
  QUALITY_PRESETS,
  SERVER_BUDGET_KBPS,
  applyColorMode,
  candidateFormats,
  encodeFrame,
  estimateBandwidth,
  fitSize,
  formatBytes,
  pickSmallest,
  sniffImageMime,
  type EncodeCanvas,
  type EncodeContext,
} from './codec';

// ---- 形式の見分け・縮小・色数・候補・選び方（純粋） ----

describe('sniffImageMime', () => {
  it('JPEG・PNG・WebP を、先頭の base64 から見分ける。それ以外は null', () => {
    expect(sniffImageMime('/9j/4AAQ')).toBe('image/jpeg');
    expect(sniffImageMime('iVBORw0KGgoAAA')).toBe('image/png');
    expect(sniffImageMime('UklGRAAAAAAARUJQVlA4')).toBe('image/webp');
    expect(sniffImageMime('PHN2Zz48L3N2Zz4=')).toBeNull();
    // RIFF だが WEBP でないもの（WAV など）は webp にしない
    expect(sniffImageMime('UklGRAAAAAAAWAVEfmt')).toBeNull();
  });
});

describe('fitSize', () => {
  it('長辺を maxEdge に収める。拡大はしない（小さい画面は、そのまま）', () => {
    expect(fitSize(1920, 1080, 1280)).toEqual({ w: 1280, h: 720 });
    expect(fitSize(800, 600, 1280)).toEqual({ w: 800, h: 600 });
  });

  it('scale は画質調整の倍率。0 より小さくならない（最小は 1px）', () => {
    expect(fitSize(1000, 500, 1000, 0.5)).toEqual({ w: 500, h: 250 });
    expect(fitSize(1, 1, 1)).toEqual({ w: 1, h: 1 });
    expect(fitSize(100000, 1, 10)).toEqual({ w: 10, h: 1 });
  });
});

describe('applyColorMode', () => {
  it('full は触らない', () => {
    const data = new Uint8ClampedArray([10, 200, 30, 255]);
    applyColorMode(data, 'full');
    expect([...data]).toEqual([10, 200, 30, 255]);
  });

  it('c256: 固定の格子ではなく、この画面の色から選んだ代表色にそろえる（アルファは残す）', () => {
    // 単色の画面なら、その色そのもの（旧い格子では 146・146・170 に変わっていた）
    const data = new Uint8ClampedArray([128, 128, 128, 255, 128, 128, 128, 255]);
    applyColorMode(data, 'c256');
    expect([...data]).toEqual([128, 128, 128, 255, 128, 128, 128, 255]);
    const alpha = new Uint8ClampedArray([10, 20, 30, 77, 200, 100, 50, 0]);
    applyColorMode(alpha, 'c256');
    expect([alpha[3], alpha[7]]).toEqual([77, 0]);
  });

  it('gray: 輝度（R=G=B）。アルファは残す', () => {
    const data = new Uint8ClampedArray([100, 0, 0, 77]);
    applyColorMode(data, 'gray');
    expect([...data]).toEqual([30, 30, 30, 77]);
  });
});

describe('candidateFormats / pickSmallest', () => {
  it('フルカラーは JPEG だけ。減色は形式を試す（小さいものを選ぶため）', () => {
    expect(candidateFormats('full')).toEqual(['image/jpeg']);
    expect(candidateFormats('c256')).toEqual(['image/png', 'image/webp']);
    expect(candidateFormats('gray')).toEqual(['image/jpeg', 'image/webp', 'image/png']);
  });

  it('いちばん小さい形式を選ぶ。同じなら先に挙げたほう。空なら null', () => {
    expect(pickSmallest({ 'image/jpeg': 300, 'image/webp': 100, 'image/png': 200 })).toBe('image/webp');
    expect(pickSmallest({ 'image/png': 50, 'image/webp': 50 })).toBe('image/png');
    expect(pickSmallest({})).toBeNull();
  });
});

describe('estimateBandwidth / formatBytes', () => {
  it('画像のバイト数は base64 の 3/4。毎秒の流れは fps 倍（予算を超えたら上限で止まる）', () => {
    expect(estimateBandwidth(1000, 5)).toEqual({ imageBytes: 750, bytesPerSec: 5000, capped: false });
    const big = estimateBandwidth(1_000_000, 20);
    expect(big.capped).toBe(true);
    expect(big.bytesPerSec).toBe(SERVER_BUDGET_KBPS * 1024);
  });

  it('バイト数は KB / MB。0 でも 1 KB と出す', () => {
    expect(formatBytes(0)).toBe('1 KB');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('定数（凍っている・旧い版と同じ値）', () => {
  it('画質・FPS・色数は、固定の値', () => {
    expect(Object.isFrozen(QUALITY_PRESETS)).toBe(true);
    expect(QUALITY_PRESETS.p720.quality).toBe(0.6);
    expect(QUALITY_PRESETS.p1080.maxEdge).toBe(1920);
    expect(FPS_OPTIONS).toEqual([5, 20]);
    expect(Object.keys(COLOR_MODES)).toEqual(['full', 'c256', 'gray']);
  });
});

// ---- encodeFrame（偽の canvas で。形式の選び方と、色数の段階） ----

/** 偽の canvas。toDataURL は形式ごとの「画像」を返す（先頭の署名と長さを決められる） */
function fakeCanvas(opts: { images: Record<string, string>; ctxNull?: boolean }) {
  const calls: { type: string; quality?: number }[] = [];
  const puts: Uint8ClampedArray[] = [];
  const imageData = new Uint8ClampedArray([100, 0, 0, 255]);
  const ctx: EncodeContext = {
    drawImage: () => {},
    getImageData: () => ({ data: imageData }),
    putImageData: (img) => puts.push(new Uint8ClampedArray(img.data)),
  };
  const cv: EncodeCanvas = {
    width: 0,
    height: 0,
    getContext: () => (opts.ctxNull ? null : ctx),
    toDataURL: (type, quality) => {
      calls.push({ type, quality });
      return `data:${type};base64,${opts.images[type] ?? '/9j/'}`;
    },
  };
  return { cv, calls, puts };
}

const JPEG = '/9j/' + 'A'.repeat(100);
const WEBP = 'UklGR' + 'A'.repeat(7) + 'RUJQ' + 'A'.repeat(20);
const PNG = 'iVBORw0KGgo' + 'A'.repeat(300);

describe('encodeFrame', () => {
  it('フルカラーは JPEG だけを作る（候補は 1 つ）', () => {
    const { cv, calls } = fakeCanvas({ images: { 'image/jpeg': JPEG } });
    const out = encodeFrame(cv, {}, 640, 360, { color: 'full', quality: 0.6, format: null });
    expect(out).toEqual({ mime: 'image/jpeg', b64: JPEG });
    expect(calls.map((c) => c.type)).toEqual(['image/jpeg']);
    expect(cv.width).toBe(640);
    expect(cv.height).toBe(360);
  });

  it('灰色は候補をすべて試して、いちばん小さいもの（ここでは WebP）を返す', () => {
    const { cv, calls } = fakeCanvas({ images: { 'image/jpeg': JPEG, 'image/webp': WEBP, 'image/png': PNG } });
    const out = encodeFrame(cv, {}, 10, 10, { color: 'gray', quality: 0.5, format: null });
    expect(out.mime).toBe('image/webp');
    expect(out.b64).toBe(WEBP);
    expect(calls.map((c) => c.type)).toEqual(['image/jpeg', 'image/webp', 'image/png']);
  });

  it('形式を指定したら、その 1 つだけを作る', () => {
    const { cv, calls } = fakeCanvas({ images: { 'image/png': PNG } });
    const out = encodeFrame(cv, {}, 10, 10, { color: 'c256', quality: 0.5, format: 'image/png' });
    expect(calls.map((c) => c.type)).toEqual(['image/png']);
    expect(out.mime).toBe('image/png');
  });

  it('作れない形式は別の形式で返ってくるので、実際の形式で数える（同じ形式を二度数えない）', () => {
    // WebP を頼んだのに、PNG が返ってくる（作れない環境）
    const { cv } = fakeCanvas({ images: { 'image/png': PNG, 'image/webp': PNG } });
    const out = encodeFrame(cv, {}, 10, 10, { color: 'c256', quality: 0.5, format: null });
    expect(out.mime).toBe('image/png');
    expect(out.b64).toBe(PNG);
  });

  it('減色のときは、画素に色数の処理を入れてから書き戻す', () => {
    const { cv, puts } = fakeCanvas({ images: { 'image/png': PNG, 'image/webp': WEBP } });
    encodeFrame(cv, {}, 1, 1, { color: 'gray', quality: 0.5, format: 'image/webp' });
    expect(puts).toHaveLength(1);
    expect([...puts[0]]).toEqual([30, 30, 30, 255]);
  });

  it('canvas の文脈が取れなければ、例外（送らない）', () => {
    const { cv } = fakeCanvas({ images: {}, ctxNull: true });
    expect(() => encodeFrame(cv, {}, 1, 1, { color: 'full', quality: 0.5, format: null })).toThrow('canvas を使えません');
  });
});
