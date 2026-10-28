// ステップ7（方針の移行）: capabilities() のテスト（Tauri だけ。ブラウザー版は持たない）。
// 1. Rust の表（platform.rs の capabilities_for）と、TS の推測（Rust の値が無いとき）が同じ結果になる。
// 2. Rust の値があれば、それが使われる（項目ごと。形が違う項目だけ推測に戻る）。
// 3. その値が、経路（select・boot）と通知・更新・画面共有などの判断を実際に変える。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { capabilities } from './platform';
import { bootChatTransport, bootReadApi, bootWriteApi, currentBootEnv, currentChatBootEnv } from './transport/boot';
import { injectedPlatform, rustCapabilities, stubTauri, type TauriOs } from './testing/tauriEnv';

const OSES: TauriOs[] = ['windows', 'linux', 'other', 'android'];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('推測（Rust の値が無いとき）は Rust の表と同じ', () => {
  it.each(OSES)('Tauri の %s', (os) => {
    stubTauri({ os });
    expect(capabilities()).toEqual(rustCapabilities(os));
  });

  it('Tauri の注入が無い（想定外の失敗）ときも、UA から推測して Rust の表と同じ。通知は desktop か android', () => {
    stubTauri({ os: 'windows' });
    const c = capabilities();
    expect(c).toEqual(rustCapabilities('windows'));
    expect(['android', 'desktop']).toContain(c.notifyBackend);
  });
});

describe('Rust の値があるとき', () => {
  it.each(OSES)('Tauri の %s は同じ表', (os) => {
    stubTauri({ os, inject: injectedPlatform(os) });
    expect(capabilities()).toEqual(rustCapabilities(os));
  });

  it('形が違う項目だけ推測に戻り、正しい項目は Rust の値を使う', () => {
    // Windows の推測は sharedStorage=true。Rust が false と言えば false（優先）。notifyBackend・updater は壊れているので推測に戻る
    stubTauri({
      os: 'windows',
      inject: injectedPlatform('windows', {
        sharedStorage: false,
        notifyBackend: 'web',
        bodyMode: 1,
        updater: 'x',
        nativeScreen: 5,
      }),
    });
    const c = capabilities();
    expect(c.sharedStorage).toBe(false);
    expect(c.notifyBackend).toBe('desktop');
    expect(c.bodyMode).toBe('raw');
    expect(c.updater).toBe('desktop');
    expect(c.nativeScreen).toBe(null);
  });

  it('capabilities が無い（古い形）ときは、すべて推測', () => {
    stubTauri({ os: 'linux', inject: { os: 'linux', desktop: true, android: false } });
    expect(capabilities()).toEqual(rustCapabilities('linux'));
  });

  it('Rust の値は UA より優先する（矛盾するとき）', () => {
    // UA は Android だが、Rust は Linux と言っている
    stubTauri({ os: 'android', inject: injectedPlatform('linux') });
    expect(capabilities().nativeScreen).toBe('linux');
    expect(capabilities().bodyMode).toBe('raw');
  });
});

describe('方針の値が、判断を実際に変える', () => {
  it('rustApi が false なら、Windows でも読取と書込は http、チャットは無い', () => {
    stubTauri({ os: 'windows', inject: injectedPlatform('windows', { ...rustCapabilities('windows'), rustApi: false }) });
    const env = currentBootEnv();
    expect(env.rustApi).toBe(false);
    expect(bootReadApi({ ...env, log: undefined }).kind).toBe('http');
    expect(bootWriteApi({ ...env, log: undefined }).kind).toBe('http');
    expect(bootChatTransport(currentChatBootEnv())).toBeNull();
  });

  it('bodyMode が raw なら、Android の本体は base64 にならない（boot の値）', () => {
    stubTauri({ os: 'android', inject: injectedPlatform('android', { ...rustCapabilities('android'), bodyMode: 'raw' }) });
    expect(currentBootEnv().bodyMode).toBe('raw');
  });

  it('notifyBackend の値が通知の backend になる', async () => {
    stubTauri({ os: 'windows', inject: injectedPlatform('windows', { ...rustCapabilities('windows'), notifyBackend: 'android' }) });
    vi.resetModules();
    const { notifications } = await import('./stores/notifications.svelte');
    expect(notifications.backend).toBe('android');
  });

  it('updater の値が無効（想定外）なら、推測（この OS の既定）に戻る', () => {
    stubTauri({ os: 'linux', inject: injectedPlatform('linux', { ...rustCapabilities('linux'), updater: 'nope' }) });
    expect(capabilities().updater).toBe('desktop');
  });

  it('nativeScreen が null なら、Linux でも画面共有は使えない（既定）', async () => {
    stubTauri({ os: 'linux', inject: injectedPlatform('linux', { ...rustCapabilities('linux'), nativeScreen: null }) });
    vi.resetModules();
    const { screenCaptureApi } = await import('./plugins/nativeScreen');
    expect(screenCaptureApi.supported).toBe(false);
  });
});
