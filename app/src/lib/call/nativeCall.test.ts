// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installCallLogForwarding, keepWebViewEnabled, setKeepWebViewResumed } from './nativeCall';

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

  it('Android でないとき、設定とログの転送は何もしない（console はそのまま）', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(() => setKeepWebViewResumed(false)).not.toThrow();
    installCallLogForwarding();
    console.info('[call] テスト');
    expect(info).toHaveBeenCalledWith('[call] テスト');
  });
});
