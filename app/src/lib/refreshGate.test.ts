// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createRefreshGate, REFRESH_MIN_MS } from './refreshGate';
import { onForeground } from './foreground';

describe('createRefreshGate（読み直しの間引き）', () => {
  it('最初は通し、最短の間隔の内は通さず、過ぎたら通す', () => {
    let t = 1_000;
    const g = createRefreshGate(() => t);
    expect(g.allow()).toBe(true);
    t += REFRESH_MIN_MS - 1;
    expect(g.allow()).toBe(false);
    t += 1;
    expect(g.allow()).toBe(true);
    expect(g.allow()).toBe(false);
  });

  it('間隔は 5 秒', () => {
    expect(REFRESH_MIN_MS).toBe(5_000);
  });
});

describe('onForeground（ウィンドウに戻ったとき）', () => {
  it('フォーカスと、表示になったときに呼ぶ。隠れたときは呼ばない。外すと届かない', () => {
    let calls = 0;
    const off = onForeground(() => calls++);
    window.dispatchEvent(new Event('focus'));
    expect(calls).toBe(1);

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(calls).toBe(1);

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(calls).toBe(2);

    off();
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(calls).toBe(2);
    delete (document as unknown as Record<string, unknown>).visibilityState;
  });
});
