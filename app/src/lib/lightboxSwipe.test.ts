import { describe, expect, it } from 'vitest';
import { swipeOutcome } from './lightboxSwipe';

describe('swipeOutcome（左右のスワイプで前後へ移るか）', () => {
  it('幅の 1/4 以上動かせば、ゆっくりでも移る（左へは次、右へは前）', () => {
    expect(swipeOutcome(-100, 1000, 400)).toBe(1);
    expect(swipeOutcome(100, 1000, 400)).toBe(-1);
  });

  it('短くても速く払えば移る。遅くて短ければ戻す', () => {
    expect(swipeOutcome(-60, 80, 400)).toBe(1);
    expect(swipeOutcome(-60, 600, 400)).toBeNull();
  });

  it('ごく短い動きは、速くても移らない', () => {
    expect(swipeOutcome(-20, 10, 400)).toBeNull();
  });
});
