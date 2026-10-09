import { describe, expect, it } from 'vitest';
import { SWIPE_LOCK_PX, SWIPE_MAX_PX, SWIPE_TRIGGER_PX, swipeAxis, swipeOffset, swipeProgress, swipeTriggered } from './swipe';

describe('swipeAxis', () => {
  it('小さな動きではまだ決めない', () => {
    expect(swipeAxis(SWIPE_LOCK_PX - 1, 0)).toBeNull();
    expect(swipeAxis(0, 0)).toBeNull();
  });

  it('横の動きが優勢なら x、縦が優勢なら y', () => {
    expect(swipeAxis(-30, 5)).toBe('x');
    expect(swipeAxis(-5, 30)).toBe('y');
    expect(swipeAxis(0, -20)).toBe('y');
  });

  it('横と縦が同じくらいなら y（スクロールを優先）', () => {
    expect(swipeAxis(-10, 10)).toBe('y');
  });
});

describe('swipeOffset', () => {
  it('右へは動かない', () => {
    expect(swipeOffset(30)).toBe(0);
    expect(swipeOffset(0)).toBe(0);
  });

  it('しきい値までは指に追従する', () => {
    expect(swipeOffset(-20)).toBe(-20);
    expect(swipeOffset(-SWIPE_TRIGGER_PX)).toBe(-SWIPE_TRIGGER_PX);
  });

  it('しきい値を超えると重くなり、最大を超えない', () => {
    const over = swipeOffset(-(SWIPE_TRIGGER_PX + 40));
    expect(over).toBeLessThan(-SWIPE_TRIGGER_PX);
    expect(over).toBeGreaterThan(-(SWIPE_TRIGGER_PX + 40));
    expect(swipeOffset(-1000)).toBe(-SWIPE_MAX_PX);
  });
});

describe('swipeTriggered', () => {
  it('しきい値（既定 60px）ちょうどから発動する', () => {
    expect(swipeTriggered(-(SWIPE_TRIGGER_PX - 1))).toBe(false);
    expect(swipeTriggered(-SWIPE_TRIGGER_PX)).toBe(true);
    expect(swipeTriggered(-200)).toBe(true);
  });

  it('右への動きでは発動しない', () => {
    expect(swipeTriggered(100)).toBe(false);
  });
});

describe('swipeProgress', () => {
  it('0 から 1 の間で、しきい値で 1 になる', () => {
    expect(swipeProgress(0)).toBe(0);
    expect(swipeProgress(-SWIPE_TRIGGER_PX / 2)).toBeCloseTo(0.5);
    expect(swipeProgress(-SWIPE_TRIGGER_PX * 3)).toBe(1);
    expect(swipeProgress(50)).toBe(0);
  });
});
