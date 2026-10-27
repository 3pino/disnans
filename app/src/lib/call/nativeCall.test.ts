// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keepWebViewEnabled, setKeepWebViewResumed } from './nativeCall';

describe('nativeCall（Android 以外では何もしない）', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("'disnans.keepWebViewResumed'='0' のときだけ、WebView を止める（既定は動かし続ける）", () => {
    expect(keepWebViewEnabled()).toBe(true);
    localStorage.setItem('disnans.keepWebViewResumed', '0');
    expect(keepWebViewEnabled()).toBe(false);
    localStorage.setItem('disnans.keepWebViewResumed', '1');
    expect(keepWebViewEnabled()).toBe(true);
  });

  it('Android でないとき、WebView の設定は何もしない', () => {
    expect(() => setKeepWebViewResumed(false)).not.toThrow();
  });
});
