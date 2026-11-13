// 貼り付けの経路（pasteSource）のテスト。Tauri の WebView を明示して作る（ブラウザー版は持たない）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pasteSource } from './pasteSource';
import { injectedPlatform, stubTauri, type TauriOs } from '../test-support/tauriEnv';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('pasteSource（Rust の注入値があるとき）', () => {
  it.each<[TauriOs, boolean, boolean]>([
    ['android', true, false],
    ['linux', false, true],
    ['windows', false, false],
    ['other', false, false],
  ])('Tauri の %s: android=%s, linuxDesktop=%s', (os, android, linuxDesktop) => {
    stubTauri({ os, inject: injectedPlatform(os) });
    expect(pasteSource()).toEqual({ android, linuxDesktop });
  });

  it('Android では linuxDesktop は必ず false（両方が true になることは無い）', () => {
    stubTauri({ os: 'android', inject: injectedPlatform('android') });
    const s = pasteSource();
    expect(s.android).toBe(true);
    expect(s.linuxDesktop).toBe(false);
  });
});

describe('pasteSource（Rust の注入値が無いとき: UA から推測）', () => {
  it('Android の UA は android、Linux の Tauri は linuxDesktop', () => {
    stubTauri({ os: 'android' });
    expect(pasteSource()).toEqual({ android: true, linuxDesktop: false });
    vi.unstubAllGlobals();
    stubTauri({ os: 'linux' });
    expect(pasteSource()).toEqual({ android: false, linuxDesktop: true });
  });
});

describe('pasteSource（Tauri ではない）', () => {
  it('どちらも false', () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', platform: 'Linux x86_64' });
    expect(pasteSource()).toEqual({ android: false, linuxDesktop: false });
  });
});
