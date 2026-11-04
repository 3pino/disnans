import { describe, expect, it } from 'vitest';
import { MAX_DELAY_MS, frameWeight, nextInterval, tuneQuality } from './pacing';
import { framePeakDiff, frameDiff, isBlankFrame, shouldSend } from './diff';

const preset = { label: 'x', maxEdge: 1280, quality: 0.6 };

describe('送る間隔と画質', () => {
  it('間隔は fps の上限と予算の長いほう、上限 5 秒', () => {
    expect(nextInterval({ fps: 5, weight: 1, budgetKBps: 2400 })).toBe(200);
    expect(nextInterval({ fps: 20, weight: 2400, budgetKBps: 2400 })).toBe(1000);
    expect(nextInterval({ fps: 5, weight: 1e9, budgetKBps: 1 })).toBe(MAX_DELAY_MS);
  });

  it('重さは分割数と KB の和', () => {
    expect(frameWeight(2048, 3)).toBe(5);
  });

  it('重いフレームは quality を下げ、下限後は scale を下げる', () => {
    const big = 2400 * 1024 * 0.6 + 1;
    const a = tuneQuality({ quality: 0.6, scale: 1 }, big, preset);
    expect(a.quality).toBeCloseTo(0.5);
    const b = tuneQuality({ quality: 0.35, scale: 1 }, big, preset);
    expect(b).toEqual({ quality: 0.35, scale: 0.8 });
  });

  it('軽いフレームは scale、次に quality を戻す（上限は preset）', () => {
    const small = 0;
    expect(tuneQuality({ quality: 0.5, scale: 0.5 }, small, preset)).toEqual({ quality: 0.5, scale: 0.575 });
    expect(tuneQuality({ quality: 0.58, scale: 1 }, small, preset).quality).toBe(0.6);
  });
});

describe('変化の判定', () => {
  it('平均と最大の差・空の画像', () => {
    const a = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]);
    const b = new Uint8ClampedArray([10, 10, 10, 255, 0, 0, 0, 255]);
    expect(frameDiff(a, b)).toBeCloseTo(5, 5); // 差 30 ÷ 色 6 本
    expect(framePeakDiff(a, b)).toBeCloseTo(10);
    expect(frameDiff(a, new Uint8ClampedArray(4))).toBe(Infinity);
    expect(isBlankFrame(new Uint8ClampedArray([0, 0, 0, 0]))).toBe(true);
    expect(isBlankFrame(new Uint8ClampedArray([0, 0, 0, 1]))).toBe(false);
  });

  it('送るのは、変わった・強制・送ってから 5 秒以上のとき', () => {
    expect(shouldSend({ diff: 0, sinceSentMs: 0, force: false })).toBe(false);
    expect(shouldSend({ diff: 2, sinceSentMs: 0, force: false })).toBe(true);
    expect(shouldSend({ diff: 0, peak: 30, sinceSentMs: 0, force: false })).toBe(true);
    expect(shouldSend({ diff: 0, sinceSentMs: 5000, force: false })).toBe(true);
    expect(shouldSend({ diff: 0, sinceSentMs: 0, force: true })).toBe(true);
  });
});
