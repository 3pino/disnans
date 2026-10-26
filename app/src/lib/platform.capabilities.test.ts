// ステップ7（方針の移行）: capabilities() のテスト。
// 1. Rust の表（platform.rs の capabilities_for）と、TS の推測（Rust の値が無いとき）が同じ結果になる。
// 2. Rust の値があれば、それが使われる（項目ごと。形が違う項目だけ推測に戻る）。
// 3. その値が、経路（select・boot）と通知・更新・画面共有などの判断を実際に変える。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { capabilities, type Capabilities } from './platform';
import { bootChatTransport, bootReadApi, bootWriteApi, currentBootEnv } from './transport/boot';

type Os = 'windows' | 'linux' | 'other' | 'android';

const UA: Record<Os, string> = {
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) WebKitGTK/2.44',
  other: 'Mozilla/5.0 (OtherOS; x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
};
const PLATFORM: Record<Os, string> = { windows: 'Win32', linux: 'Linux x86_64', other: 'Other', android: 'Linux armv8l' };

/** Rust の capabilities_for と同じ規則（テストの側に写したもの。Rust 側のテストと対になる） */
function rustCaps(os: Os): Capabilities {
  const desktop = os !== 'android';
  const android = os === 'android';
  const shared = desktop && (os === 'windows' || os === 'linux');
  return {
    sharedStorage: shared || android,
    rustApi: shared || android,
    rustChat: shared || android ? 'default' : 'off',
    bodyMode: android ? 'base64' : 'raw',
    notifyBackend: android ? 'android' : 'desktop',
    updater: android ? 'android' : 'desktop',
    nativeAudioOutput: android,
    backgroundService: android,
    nativeScreen: android ? 'android' : os === 'linux' ? 'linux' : null,
    devFolder: !android,
  };
}

/** 環境を差し替える。tauri のときだけ内部オブジェクトを置く。inject は Rust の値 */
function stub(opts: { tauri: boolean; os?: Os; inject?: unknown }): void {
  const os = opts.os ?? 'windows';
  vi.stubGlobal('navigator', { userAgent: UA[os], platform: PLATFORM[os] });
  const window: Record<string, unknown> = {
    location: { search: '' },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  };
  if (opts.tauri) window.__TAURI_INTERNALS__ = {};
  if (opts.inject !== undefined) window.__DISNANS_PLATFORM__ = opts.inject;
  vi.stubGlobal('window', window);
}

/** Rust が入れる値（platform.rs の PlatformInfo と同じ形） */
function injectedFor(os: Os, capsOverride?: unknown): unknown {
  return {
    os,
    desktop: os !== 'android',
    android: os === 'android',
    capabilities: capsOverride === undefined ? rustCaps(os) : capsOverride,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('推測（Rust の値が無いとき）は Rust の表と同じ', () => {
  it.each(['windows', 'linux', 'other', 'android'] as const)('Tauri の %s', (os) => {
    stub({ tauri: true, os });
    expect(capabilities()).toEqual(rustCaps(os));
  });

  it('ブラウザー（Tauri でない）は、Rust の無い既定の値', () => {
    for (const os of ['windows', 'linux', 'other', 'android'] as const) {
      stub({ tauri: false, os });
      expect(capabilities()).toEqual({
        sharedStorage: false,
        rustApi: false,
        rustChat: 'off',
        bodyMode: 'raw',
        notifyBackend: 'web',
        updater: null,
        nativeAudioOutput: false,
        backgroundService: false,
        nativeScreen: null,
        devFolder: false,
      });
    }
  });
});

describe('Rust の値があるとき', () => {
  it.each(['windows', 'linux', 'other', 'android'] as const)('Tauri の %s は同じ表', (os) => {
    stub({ tauri: true, os, inject: injectedFor(os) });
    expect(capabilities()).toEqual(rustCaps(os));
  });

  it('形が違う項目だけ推測に戻り、正しい項目は Rust の値を使う', () => {
    // Windows の推測は sharedStorage=true。Rust が false と言えば false（優先）。rustChat は壊れているので推測（default）
    stub({
      tauri: true,
      os: 'windows',
      inject: injectedFor('windows', {
        sharedStorage: false,
        rustChat: 'bogus',
        bodyMode: 1,
        updater: 'x',
        nativeScreen: 5,
      }),
    });
    const c = capabilities();
    expect(c.sharedStorage).toBe(false);
    expect(c.rustChat).toBe('default');
    expect(c.bodyMode).toBe('raw');
    expect(c.updater).toBe('desktop');
    expect(c.nativeScreen).toBe(null);
  });

  it('capabilities が無い（古い形）ときは、すべて推測', () => {
    stub({ tauri: true, os: 'linux', inject: { os: 'linux', desktop: true, android: false } });
    expect(capabilities()).toEqual(rustCaps('linux'));
  });

  it('Rust の値は UA より優先する（矛盾するとき）', () => {
    // UA は Android だが、Rust は Linux と言っている
    stub({ tauri: true, os: 'android', inject: injectedFor('linux') });
    expect(capabilities().nativeScreen).toBe('linux');
    expect(capabilities().bodyMode).toBe('raw');
  });
});

describe('方針の値が、判断を実際に変える', () => {
  it('rustApi が false なら、Windows でも読取と書込は http', () => {
    stub({ tauri: true, os: 'windows', inject: injectedFor('windows', { ...rustCaps('windows'), rustApi: false }) });
    const env = currentBootEnv();
    expect(env.rustApi).toBe(false);
    expect(bootReadApi({ ...env, log: undefined }).kind).toBe('http');
    expect(bootWriteApi({ ...env, log: undefined }).kind).toBe('http');
  });

  it('rustChat が off なら、Windows でもチャットは js', () => {
    stub({ tauri: true, os: 'windows', inject: injectedFor('windows', { ...rustCaps('windows'), rustChat: 'off' }) });
    const env = currentBootEnv();
    const t = bootChatTransport({ flag: null, desktop: env.desktop, android: env.android, rustChat: 'off', invoke: env.invoke, context: env.context, log: undefined });
    expect(t).toBeNull();
  });

  it('bodyMode が raw なら、Android の本体は base64 にならない（boot の値）', () => {
    stub({ tauri: true, os: 'android', inject: injectedFor('android', { ...rustCaps('android'), bodyMode: 'raw' }) });
    expect(currentBootEnv().bodyMode).toBe('raw');
  });

  it('notifyBackend の値が通知の backend になる', async () => {
    stub({ tauri: true, os: 'windows', inject: injectedFor('windows', { ...rustCaps('windows'), notifyBackend: 'android' }) });
    vi.resetModules();
    const { notifications } = await import('./stores/notifications.svelte');
    expect(notifications.backend).toBe('android');
  });

  it('updater が null なら、Tauri でもアップデートは対象外', async () => {
    stub({ tauri: true, os: 'linux', inject: injectedFor('linux', { ...rustCaps('linux'), updater: null }) });
    vi.resetModules();
    const { updater } = await import('./stores/updater.svelte');
    expect(updater.supported).toBe(false);
  });

  it('nativeScreen が null なら、Linux でも画面共有は使えない（既定）', async () => {
    stub({ tauri: true, os: 'linux', inject: injectedFor('linux', { ...rustCaps('linux'), nativeScreen: null }) });
    vi.resetModules();
    const { screenCaptureApi } = await import('./plugins/nativeScreen');
    expect(screenCaptureApi.supported).toBe(false);
  });
});
