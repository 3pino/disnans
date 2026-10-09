import { describe, expect, it } from 'vitest';
import {
  anyTransparent,
  canResizeImage,
  estimateBytes,
  fitSize,
  isAnimatedImage,
  outputMime,
  outputName,
  resizeOptions,
} from './imageResize';

const enc = (s: string) => [...s].map((c) => c.charCodeAt(0));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const chunk = (type: string, data: number[]) => [...be32(data.length), ...enc(type), ...data, 0, 0, 0, 0];

describe('fitSize', () => {
  it('fits the long edge and keeps the aspect ratio', () => {
    expect(fitSize(4032, 3024, 2560)).toEqual({ width: 2560, height: 1920 });
    expect(fitSize(3024, 4032, 1600)).toEqual({ width: 1200, height: 1600 });
  });
  it('never enlarges', () => {
    expect(fitSize(800, 600, 1024)).toEqual({ width: 800, height: 600 });
    expect(fitSize(1024, 1024, 1024)).toEqual({ width: 1024, height: 1024 });
  });
  it('keeps at least 1px', () => {
    expect(fitSize(10000, 1, 1024)).toEqual({ width: 1024, height: 1 });
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

describe('estimateBytes', () => {
  it('scales the size by pixel ratio when the format stays the same', () => {
    const src = { size: 4_000_000, mime: 'image/jpeg', width: 4000, height: 3000 };
    expect(estimateBytes(src, { width: 2000, height: 1500 }, false)).toBe(1_000_000);
  });
  it('estimates from pixels when the format changes', () => {
    const src = { size: 8_000_000, mime: 'image/png', width: 4000, height: 3000 };
    expect(estimateBytes(src, { width: 2000, height: 1500 }, false)).toBe(Math.round(3_000_000 * 0.3));
    // PNG の透過あり → PNG は同じ形式なので、元のサイズに比例させる
    expect(estimateBytes(src, { width: 2000, height: 1500 }, true)).toBe(2_000_000);
    const webp = { size: 1_000_000, mime: 'image/webp', width: 1000, height: 1000 };
    expect(estimateBytes(webp, { width: 500, height: 500 }, true)).toBe(500_000);
  });
});

describe('resizeOptions', () => {
  const info = { width: 4032, height: 3024, alpha: false, animated: false };
  const source = { size: 3_000_000, mime: 'image/jpeg' };

  it('puts the original first, enabled, with its real size', () => {
    const [orig] = resizeOptions(info, source);
    expect(orig.choice.id).toBe('original');
    expect(orig.disabled).toBe(false);
    expect(orig.bytes).toBe(3_000_000);
    expect([orig.width, orig.height]).toEqual([4032, 3024]);
  });

  it('gives the fitted size for each choice', () => {
    const opts = resizeOptions(info, source);
    expect(opts.map((o) => [o.width, o.height])).toEqual([
      [4032, 3024],
      [2560, 1920],
      [1600, 1200],
      [1024, 768],
    ]);
  });

  it('disables choices that would not shrink the image', () => {
    const small = resizeOptions({ width: 1500, height: 1000, alpha: false, animated: false }, source);
    expect(small.map((o) => o.disabled)).toEqual([false, true, true, false]);
    expect(small[1].bytes).toBe(3_000_000);
  });
});

describe('canResizeImage', () => {
  it('rejects missing info and animated images', () => {
    expect(canResizeImage(null)).toBe(false);
    expect(canResizeImage({ width: 1, height: 1, alpha: false, animated: true })).toBe(false);
    expect(canResizeImage({ width: 1, height: 1, alpha: false, animated: false })).toBe(true);
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
