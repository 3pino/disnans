import { describe, expect, it } from 'vitest';
import {
  IDENTITY_VIEW,
  MAX_ZOOM,
  MIN_ZOOM,
  clampScale,
  clampView,
  isDoubleTap,
  pinchView,
  zoomAt,
  zoomByWheel,
} from './zoom';

/** 画像上の点 u が、表示 v のもとで舞台のどこに来るか（舞台の中心からの位置） */
const screenOf = (v: { scale: number; x: number; y: number }, u: { x: number; y: number }) => ({
  x: v.x + u.x * v.scale,
  y: v.y + u.y * v.scale,
});

describe('clampScale', () => {
  it('keeps the scale between 1x and 5x', () => {
    expect(clampScale(0.5)).toBe(MIN_ZOOM);
    expect(clampScale(3)).toBe(3);
    expect(clampScale(9)).toBe(MAX_ZOOM);
  });
});

describe('zoomAt', () => {
  it('keeps the point under the center fixed', () => {
    const v = { scale: 2, x: 10, y: -20 };
    const p = { x: 100, y: 50 };
    const u = { x: (p.x - v.x) / v.scale, y: (p.y - v.y) / v.scale };
    const r = zoomAt(v, 4, p);
    expect(r.scale).toBe(4);
    const s = screenOf(r, u);
    expect(s.x).toBeCloseTo(p.x);
    expect(s.y).toBeCloseTo(p.y);
  });

  it('clamps the new scale', () => {
    expect(zoomAt(IDENTITY_VIEW, 10, { x: 0, y: 0 }).scale).toBe(MAX_ZOOM);
    expect(zoomAt({ scale: 2, x: 0, y: 0 }, 0.2, { x: 0, y: 0 }).scale).toBe(MIN_ZOOM);
  });
});

describe('pinchView', () => {
  it('scales by the change of the finger distance', () => {
    expect(pinchView(IDENTITY_VIEW, { x: 0, y: 0 }, 100, { x: 0, y: 0 }, 200)).toEqual({ scale: 2, x: 0, y: 0 });
  });

  it('keeps the point under the fingers under the new midpoint', () => {
    const m0 = { x: 100, y: 0 };
    const r = pinchView(IDENTITY_VIEW, m0, 100, m0, 200);
    // 始めに指の下にあった画像の点（x = 100）が、倍率を変えても指の下に残る
    const s = screenOf(r, { x: 100, y: 0 });
    expect(s.x).toBeCloseTo(100);
  });

  it('pans with one finger without changing the scale', () => {
    const v = pinchView({ scale: 2, x: 0, y: 0 }, { x: 0, y: 0 }, 0, { x: 30, y: -10 }, 0);
    expect(v.scale).toBe(2);
    expect(v.x).toBe(30);
    expect(v.y).toBe(-10);
  });

  it('clamps the scale', () => {
    expect(pinchView(IDENTITY_VIEW, { x: 0, y: 0 }, 100, { x: 0, y: 0 }, 1000).scale).toBe(MAX_ZOOM);
    expect(pinchView(IDENTITY_VIEW, { x: 0, y: 0 }, 100, { x: 0, y: 0 }, 10).scale).toBe(MIN_ZOOM);
  });
});

describe('clampView', () => {
  it('limits the pan so the image does not leave the stage', () => {
    const stage = { w: 200, h: 200 };
    const img = { w: 300, h: 300 };
    // 倍率 2 では画像は 600px。端まで 200px ずつ動ける
    expect(clampView({ scale: 2, x: 500, y: 0 }, stage, img)).toEqual({ scale: 2, x: 200, y: 0 });
    expect(clampView({ scale: 2, x: -1000, y: 1000 }, stage, img)).toEqual({ scale: 2, x: -200, y: 200 });
  });

  it('keeps the image centered when it is smaller than the stage', () => {
    const v = clampView({ scale: 1, x: 50, y: -50 }, { w: 200, h: 200 }, { w: 100, h: 100 });
    expect(v.scale).toBe(1);
    expect(v.x).toBeCloseTo(0);
    expect(v.y).toBeCloseTo(0);
  });

  it('clamps the scale too', () => {
    expect(clampView({ scale: 9, x: 0, y: 0 }, { w: 200, h: 200 }, { w: 100, h: 100 }).scale).toBe(MAX_ZOOM);
  });
});

describe('zoomByWheel', () => {
  it('zooms in when the wheel goes up and out when it goes down', () => {
    expect(zoomByWheel(2, -10)).toBeGreaterThan(2);
    expect(zoomByWheel(2, 10)).toBeLessThan(2);
  });

  it('clamps the scale', () => {
    expect(zoomByWheel(5, -1000)).toBe(MAX_ZOOM);
    expect(zoomByWheel(1, 1000)).toBe(MIN_ZOOM);
  });
});

describe('isDoubleTap', () => {
  const first = { t: 1000, x: 10, y: 10 };

  it('is true for a second tap soon after and nearby', () => {
    expect(isDoubleTap(first, { t: 1200, x: 12, y: 14 })).toBe(true);
  });

  it('is false without a previous tap', () => {
    expect(isDoubleTap(null, { t: 1200, x: 10, y: 10 })).toBe(false);
  });

  it('is false when the second tap is too late', () => {
    expect(isDoubleTap(first, { t: 1500, x: 10, y: 10 })).toBe(false);
  });

  it('is false when the second tap is too far away', () => {
    expect(isDoubleTap(first, { t: 1200, x: 100, y: 10 })).toBe(false);
  });
});
