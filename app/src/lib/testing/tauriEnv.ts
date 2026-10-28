// テスト共通の Tauri 環境（vitest 用）。ブラウザー版は持たないので、テストは Tauri の WebView を明示して作る。
// invoke は window.__TAURI_INTERNALS__.invoke に入れる（@tauri-apps/api/core がそれを呼ぶ）。呼び出しは calls に残す。
import { vi } from 'vitest';

export type TauriOs = 'windows' | 'linux' | 'android' | 'other';

export const TAURI_UA: Record<TauriOs, string> = {
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) WebKitGTK/2.44',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
  other: 'Mozilla/5.0 (OtherOS; x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)',
};

export const TAURI_PLATFORM: Record<TauriOs, string> = {
  windows: 'Win32',
  linux: 'Linux x86_64',
  android: 'Linux armv8l',
  other: 'Other',
};

/** Rust の capabilities_for（crates/client-core/src/platform.rs）と同じ表。Rust 側のテストと対になる */
export function rustCapabilities(os: TauriOs) {
  const android = os === 'android';
  const shared = os === 'windows' || os === 'linux';
  return {
    sharedStorage: shared || android,
    rustApi: shared || android,
    bodyMode: android ? 'base64' : 'raw',
    notifyBackend: android ? 'android' : 'desktop',
    updater: android ? 'android' : 'desktop',
    nativeAudioOutput: android,
    backgroundService: android,
    nativeScreen: android ? 'android' : os === 'linux' ? 'linux' : null,
    devFolder: !android,
  } as const;
}

/** Rust が `window.__DISNANS_PLATFORM__` に入れる値（platform.rs の PlatformInfo と同じ形）。capabilities を省くと、方針の無い古い形になる */
export function injectedPlatform(os: TauriOs, capabilities?: unknown): Record<string, unknown> {
  const value: Record<string, unknown> = {
    surface: 'tauri',
    os,
    desktop: os !== 'android',
    android: os === 'android',
  };
  if (capabilities !== undefined) value.capabilities = capabilities;
  else value.capabilities = rustCapabilities(os);
  return value;
}

export type TauriCall = { command: string; args: unknown };

export type TauriStubOptions = {
  os: TauriOs;
  /** window.__DISNANS_PLATFORM__。undefined なら入れない（注入の欠如） */
  inject?: unknown;
  /** localStorage の中身（例: { 'disnans.rustApi': '0' }） */
  storage?: Record<string, string>;
  /** invoke の応答。既定は null */
  reply?: (command: string, args: unknown) => unknown;
};

export type TauriStub = { calls: TauriCall[] };

/**
 * Tauri の WebView の環境を作る（navigator・window・localStorage・sessionStorage・document）。
 * 後始末は afterEach で vi.unstubAllGlobals() を呼ぶ。
 */
export function stubTauri(opts: TauriStubOptions): TauriStub {
  const calls: TauriCall[] = [];
  const reply = opts.reply ?? (() => null);
  vi.stubGlobal('navigator', { userAgent: TAURI_UA[opts.os], platform: TAURI_PLATFORM[opts.os] });
  const store = new Map(Object.entries(opts.storage ?? {}));
  const storageApi = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  const listeners: Record<string, Array<() => void>> = {};
  const window: Record<string, unknown> = {
    location: { search: '', protocol: 'tauri:', host: 'localhost' },
    localStorage: storageApi,
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    addEventListener(type: string, fn: () => void) {
      (listeners[type] ??= []).push(fn);
    },
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: unknown) => {
        calls.push({ command, args });
        const r = reply(command, args);
        if (r instanceof Error) throw r;
        return r;
      },
      // Channel（チャットの受け口）が使う。実際の登録はしない（テストは呼び出しだけを見る）
      transformCallback: () => 1,
      unregisterCallback: () => {},
    },
  };
  if (opts.inject !== undefined) window.__DISNANS_PLATFORM__ = opts.inject;
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    hasFocus: () => true,
    addEventListener() {},
  });
  return { calls };
}
