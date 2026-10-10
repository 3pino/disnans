import { describe, expect, it } from 'vitest';
import {
  anyTransparent,
  aspectRatio,
  canCropImage,
  clampRect,
  displayToSource,
  fitDisplay,
  initialRect,
  isAnimatedImage,
  isFullRect,
  moveRect,
  outputMime,
  outputName,
  rectToDisplay,
  resizeRect,
  sourceToDisplay,
} from './imageCrop';

const enc = (s: string) => [...s].map((c) => c.charCodeAt(0));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const chunk = (type: string, data: number[]) => [...be32(data.length), ...enc(type), ...data, 0, 0, 0, 0];

const IMG = { width: 1000, height: 500 };

describe('aspectRatio', () => {
  it('gives the ratio for each choice, flipped for portrait', () => {
    expect(aspectRatio('free', IMG, false)).toBeNull();
    expect(aspectRatio('square', IMG, false)).toBe(1);
    expect(aspectRatio('r4x3', IMG, false)).toBeCloseTo(4 / 3);
    expect(aspectRatio('r4x3', IMG, true)).toBeCloseTo(3 / 4);
    expect(aspectRatio('r16x9', IMG, true)).toBeCloseTo(9 / 16);
    expect(aspectRatio('original', { width: 300, height: 200 }, false)).toBe(1.5);
  });
});

describe('initialRect', () => {
  it('is the whole image when free', () => {
    expect(initialRect(IMG, null)).toEqual({ x: 0, y: 0, w: 1000, h: 500 });
  });
  it('is the largest centered rect with the ratio', () => {
    // 横長の画像を 1:1 に → 高さいっぱい、左右を中央に
    expect(initialRect(IMG, 1)).toEqual({ x: 250, y: 0, w: 500, h: 500 });
    // 縦長の画像を 3:4（縦長）に → 幅いっぱい、上下を中央に
    expect(initialRect({ width: 600, height: 1000 }, 3 / 4)).toEqual({ x: 0, y: 100, w: 600, h: 800 });
  });
});

describe('clampRect', () => {
  it('keeps the rect inside the image and rounds it', () => {
    expect(clampRect({ x: -10, y: 480, w: 2000, h: 40.4 }, IMG)).toEqual({ x: 0, y: 460, w: 1000, h: 40 });
  });
  it('keeps the minimum size of 32px', () => {
    expect(clampRect({ x: 0, y: 0, w: 3, h: 3 }, IMG)).toEqual({ x: 0, y: 0, w: 32, h: 32 });
  });
  it('allows a smaller minimum when the image itself is smaller', () => {
    expect(clampRect({ x: 0, y: 0, w: 1, h: 1 }, { width: 20, height: 10 })).toEqual({ x: 0, y: 0, w: 20, h: 10 });
  });
});

describe('moveRect', () => {
  const start = { x: 100, y: 100, w: 200, h: 100 };
  it('moves by the delta', () => {
    expect(moveRect(start, 50, -30, IMG)).toEqual({ x: 150, y: 70, w: 200, h: 100 });
  });
  it('stops at the image edges', () => {
    expect(moveRect(start, 5000, 5000, IMG)).toEqual({ x: 800, y: 400, w: 200, h: 100 });
    expect(moveRect(start, -5000, -5000, IMG)).toEqual({ x: 0, y: 0, w: 200, h: 100 });
  });
});

describe('resizeRect (free)', () => {
  const start = { x: 200, y: 100, w: 400, h: 200 };
  it('moves the dragged corner and keeps the opposite one', () => {
    // se: 右下を動かす。左上 (200,100) は固定
    expect(resizeRect(start, 'se', 100, 50, IMG, null)).toEqual({ x: 200, y: 100, w: 500, h: 250 });
    // nw: 左上を動かす。右下 (600,300) は固定
    expect(resizeRect(start, 'nw', 50, 20, IMG, null)).toEqual({ x: 250, y: 120, w: 350, h: 180 });
  });
  it('does not go past the image edge', () => {
    expect(resizeRect(start, 'se', 5000, 5000, IMG, null)).toEqual({ x: 200, y: 100, w: 800, h: 400 });
  });
  it('does not get smaller than the minimum', () => {
    expect(resizeRect(start, 'se', -368, -168, IMG, null)).toEqual({ x: 200, y: 100, w: 32, h: 32 });
    expect(resizeRect(start, 'nw', 368, 168, IMG, null)).toEqual({ x: 568, y: 268, w: 32, h: 32 });
  });
});

describe('resizeRect (fixed ratio)', () => {
  const start = { x: 0, y: 0, w: 400, h: 300 };
  it('keeps the ratio while dragging a corner', () => {
    const r = resizeRect(start, 'se', 100, 0, IMG, 4 / 3);
    expect(r).toEqual({ x: 0, y: 0, w: 500, h: 375 });
    expect(r.w / r.h).toBeCloseTo(4 / 3);
  });
  it('follows the larger of the two drags', () => {
    // 縦だけ大きく動かしても、比を保つので幅も伸びる
    const r = resizeRect(start, 'se', 0, 150, IMG, 4 / 3);
    expect(r).toEqual({ x: 0, y: 0, w: 600, h: 450 });
    expect(r.w / r.h).toBeCloseTo(4 / 3);
  });
  it('stays inside the image', () => {
    const r = resizeRect({ x: 500, y: 100, w: 400, h: 300 }, 'se', 5000, 0, IMG, 4 / 3);
    expect(r.x + r.w).toBeLessThanOrEqual(IMG.width);
    expect(r.y + r.h).toBeLessThanOrEqual(IMG.height);
    expect(r.w / r.h).toBeCloseTo(4 / 3, 1);
  });
  it('keeps the minimum size with the ratio', () => {
    const r = resizeRect(start, 'nw', 390, 290, IMG, 16 / 9);
    expect(r.w).toBeGreaterThanOrEqual(32);
    expect(r.h).toBeGreaterThanOrEqual(18);
    expect(r.x + r.w).toBe(400);
    expect(r.w / r.h).toBeCloseTo(16 / 9, 1);
  });
});

describe('display and source coordinates', () => {
  it('fits the image into the box', () => {
    expect(fitDisplay(IMG, { width: 500, height: 400 })).toEqual({ width: 500, height: 250, scale: 0.5 });
    // 小さい画像は拡大しない
    expect(fitDisplay({ width: 200, height: 100 }, { width: 500, height: 400 })).toEqual({ width: 200, height: 100, scale: 1 });
  });
  it('converts both ways', () => {
    expect(sourceToDisplay(200, 0.5)).toBe(100);
    expect(displayToSource(100, 0.5)).toBe(200);
    expect(rectToDisplay({ x: 10, y: 20, w: 30, h: 40 }, 2)).toEqual({ x: 20, y: 40, w: 60, h: 80 });
  });
});

describe('isFullRect and canCropImage', () => {
  it('detects the whole image', () => {
    expect(isFullRect({ x: 0, y: 0, w: 1000, h: 500 }, IMG)).toBe(true);
    expect(isFullRect({ x: 1, y: 0, w: 999, h: 500 }, IMG)).toBe(false);
  });
  it('rejects missing info and animated images', () => {
    expect(canCropImage(null)).toBe(false);
    expect(canCropImage({ width: 1, height: 1, alpha: false, animated: true })).toBe(false);
    expect(canCropImage({ width: 1, height: 1, alpha: false, animated: false })).toBe(true);
  });
});

describe('output format and name', () => {
  it('uses PNG only with alpha', () => {
    expect(outputMime(true)).toBe('image/png');
    expect(outputMime(false)).toBe('image/jpeg');
  });
  it('changes the extension to match the format', () => {
    expect(outputName('IMG_0001.HEIC', 'image/jpeg')).toBe('IMG_0001.jpg');
    expect(outputName('logo.webp', 'image/png')).toBe('logo.png');
    expect(outputName('photo', 'image/jpeg')).toBe('photo.jpg');
    expect(outputName('.hidden', 'image/jpeg')).toBe('image.jpg');
  });
});

describe('anyTransparent', () => {
  it('looks only at the alpha channel', () => {
    expect(anyTransparent([255, 0, 0, 255, 0, 0, 0, 255])).toBe(false);
    expect(anyTransparent([255, 0, 0, 255, 0, 0, 0, 0])).toBe(true);
    expect(anyTransparent([])).toBe(false);
  });
});

describe('isAnimatedImage', () => {
  const PNG_SIG = [0x89, ...enc('PNG'), 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);

  it('finds acTL before IDAT in a PNG (APNG)', () => {
    const apng = [...PNG_SIG, ...ihdr, ...chunk('acTL', [0, 0, 0, 2, 0, 0, 0, 0]), ...chunk('IDAT', [1, 2, 3])];
    expect(isAnimatedImage(new Uint8Array(apng))).toBe(true);
  });

  it('treats a still PNG as not animated', () => {
    const png = [...PNG_SIG, ...ihdr, ...chunk('IDAT', [1, 2, 3]), ...chunk('IEND', [])];
    expect(isAnimatedImage(new Uint8Array(png))).toBe(false);
  });

  it('detects the animation flag in VP8X and the ANIM chunk in WebP', () => {
    const riff = (chunks: number[]) => [...enc('RIFF'), ...le32(chunks.length + 4), ...enc('WEBP'), ...chunks];
    const vp8x = (flags: number) => [...enc('VP8X'), ...le32(10), flags, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const animated = new Uint8Array(riff([...vp8x(0x02), ...enc('ANIM'), ...le32(6), 0, 0, 0, 0, 0, 0]));
    const still = new Uint8Array(riff([...vp8x(0x10), ...enc('VP8L'), ...le32(4), 0, 0, 0, 0]));
    expect(isAnimatedImage(animated)).toBe(true);
    expect(isAnimatedImage(still)).toBe(false);
  });

  it('treats other data (including GIF) as not animated here', () => {
    expect(isAnimatedImage(new Uint8Array(enc('GIF89a')))).toBe(false);
    expect(isAnimatedImage(new Uint8Array([]))).toBe(false);
  });
});
