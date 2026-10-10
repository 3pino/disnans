import { describe, expect, it } from 'vitest';
import { SILENT_SWIPE_MAX_PX, SILENT_SWIPE_PX, isSilentSwipe, sendButtonLift, swipeUpLift } from './silentSend';

describe('swipeUpLift', () => {
  it('上へ動いた量を返す', () => {
    expect(swipeUpLift(300, 260)).toBe(40);
  });
  it('下へ動いたときは 0', () => {
    expect(swipeUpLift(300, 330)).toBe(0);
  });
  it('動いていなければ 0', () => {
    expect(swipeUpLift(300, 300)).toBe(0);
  });
});

describe('isSilentSwipe', () => {
  it('しきい値の手前は通常の送信', () => {
    expect(isSilentSwipe(SILENT_SWIPE_PX - 1)).toBe(false);
    expect(isSilentSwipe(0)).toBe(false);
  });
  it('しきい値に届いたら silent', () => {
    expect(isSilentSwipe(SILENT_SWIPE_PX)).toBe(true);
    expect(isSilentSwipe(SILENT_SWIPE_PX + 30)).toBe(true);
  });
});

describe('sendButtonLift', () => {
  it('動いた量のぶんだけ上へずらす', () => {
    expect(sendButtonLift(20)).toBe(20);
  });
  it('上限で止める', () => {
    expect(sendButtonLift(500)).toBe(SILENT_SWIPE_MAX_PX);
  });
  it('負や 0 は 0', () => {
    expect(sendButtonLift(-10)).toBe(0);
    expect(sendButtonLift(0)).toBe(0);
  });
});
