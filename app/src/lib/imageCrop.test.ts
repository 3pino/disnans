import { describe, expect, it, vi } from 'vitest';
import {
  anyTransparent,
  canCropImage,
  clampRect,
  displayToSource,
  fitDisplay,
  isAnimatedImage,
  isFullRect,
  moveRect,
  outputMime,
  outputName,
  rectToDisplay,
  resizeRect,
  prepareUpload,
  readImageInfo,
  sourceToDisplay,
} from './imageCrop';

const enc = (s: string) => [...s].map((c) => c.charCodeAt(0));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const chunk = (type: string, data: number[]) => [...be32(data.length), ...enc(type), ...data, 0, 0, 0, 0];

const IMG = { width: 1000, height: 500 };

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
    expect(resizeRect(start, 'se', 100, 50, IMG)).toEqual({ x: 200, y: 100, w: 500, h: 250 });
    // nw: 左上を動かす。右下 (600,300) は固定
    expect(resizeRect(start, 'nw', 50, 20, IMG)).toEqual({ x: 250, y: 120, w: 350, h: 180 });
  });
  it('does not go past the image edge', () => {
    expect(resizeRect(start, 'se', 5000, 5000, IMG)).toEqual({ x: 200, y: 100, w: 800, h: 400 });
  });
  it('does not get smaller than the minimum', () => {
    expect(resizeRect(start, 'se', -368, -168, IMG)).toEqual({ x: 200, y: 100, w: 32, h: 32 });
    expect(resizeRect(start, 'nw', 368, 168, IMG)).toEqual({ x: 568, y: 268, w: 32, h: 32 });
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
  it('uses WebP by default, and PNG or JPEG (by alpha) when WebP cannot be made', () => {
    expect(outputMime(true, false)).toBe('image/webp');
    expect(outputMime(true, true)).toBe('image/webp');
    expect(outputMime(false, true)).toBe('image/png');
    expect(outputMime(false, false)).toBe('image/jpeg');
  });
  it('changes the extension to match the format', () => {
    expect(outputName('IMG_0001.HEIC', 'image/webp')).toBe('IMG_0001.webp');
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

describe('prepareUpload（切り抜いた画像そのもの）', () => {
  // canvas は仮のもの（描いた範囲と、作る形式を記録する）。OffscreenCanvas があれば makeSurface はそれを使う
  function fakeCanvas() {
    const drawn: number[][] = [];
    const ctx = {
      drawImage: (...a: unknown[]) => drawn.push(a.slice(1) as number[]),
      getImageData: () => ({ data: new Uint8ClampedArray(4).fill(255) }),
      imageSmoothingEnabled: false,
      imageSmoothingQuality: '',
    };
    class FakeCanvas {
      getContext() {
        return ctx;
      }
      convertToBlob(o: { type: string }) {
        return Promise.resolve(new Blob(['cropped'], { type: o.type }));
      }
    }
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    return drawn;
  }

  it('切り抜きの範囲だけを描き、WebP にして、元と違うファイルを返す（上げるのはこれ）', async () => {
    vi.stubGlobal('createImageBitmap', async () => ({ width: 400, height: 300, close() {} }));
    const drawn = fakeCanvas();
    const f = new File(['orig'], 'p.png', { type: 'image/png' });
    const out = await prepareUpload(f, { x: 10, y: 20, w: 100, h: 50 });
    expect(out).not.toBe(f);
    expect(out.name).toBe('p.webp');
    expect(out.type).toBe('image/webp');
    expect(await out.text()).toBe('cropped');
    expect(drawn).toEqual([[10, 20, 100, 50, 0, 0, 100, 50]]);
    vi.unstubAllGlobals();
  });

  it('切り抜きが無い・全体のときは、元のファイルをそのまま返す', async () => {
    vi.stubGlobal('createImageBitmap', async () => ({ width: 400, height: 300, close() {} }));
    const f = new File(['orig'], 'p.png', { type: 'image/png' });
    expect(await prepareUpload(f, null)).toBe(f);
    vi.unstubAllGlobals();
  });
});

describe('向きの回転（EXIF）を両方で同じに読む', () => {
  it('縦横が入れ替わった写真も、切り抜きの範囲を画像全体と誤認しない（寸法は向きを直したもの）', async () => {
    // 横 400×縦 300 の元が、EXIF で回すと縦 300×横 400 になる。読み込みは両方とも from-image
    const calls: unknown[] = [];
    vi.stubGlobal('createImageBitmap', async (_f: Blob, o: unknown) => {
      calls.push(o);
      return { width: 300, height: 400, close() {} };
    });
    const drawn: number[][] = [];
    const ctx = { drawImage: (...a: unknown[]) => drawn.push(a.slice(1) as number[]), getImageData: () => ({ data: new Uint8ClampedArray(4).fill(255) }), imageSmoothingEnabled: false, imageSmoothingQuality: '' };
    class FakeCanvas {
      getContext() { return ctx; }
      convertToBlob(o: { type: string }) { return Promise.resolve(new Blob(['c'], { type: o.type })); }
    }
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    const f = new File(['orig'], 'photo.jpg', { type: 'image/jpeg' });
    // 表示と同じ寸法（300×400）の部分を切る。全体ではないので、元のまま返してはいけない
    const out = await prepareUpload(f, { x: 0, y: 0, w: 300, h: 200 });
    expect(out).not.toBe(f);
    expect(drawn).toEqual([[0, 0, 300, 200, 0, 0, 300, 200]]);
    expect(calls.every((o) => (o as { imageOrientation?: string }).imageOrientation === 'from-image')).toBe(true);
    const info = await readImageInfo(f);
    expect(info).toMatchObject({ width: 300, height: 400 });
    vi.unstubAllGlobals();
  });
});
