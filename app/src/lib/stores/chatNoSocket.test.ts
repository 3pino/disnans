// S7: Tauri の Windows・Linux・Android は JS Socket を作らない（チャットは必ず Rust 経路）。
// ブラウザー（開発用）と macOS（方針 off）は従来どおり JS Socket。起動時の経路の決め方（bootChatTransport）から確かめる。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeSocket {
  static instances = 0;
  constructor() {
    FakeSocket.instances++;
  }
  close() {}
  start() {}
  send() {
    return false;
  }
  reconnectNow() {}
  get bufferedAmount() {
    return 0;
  }
}

const UA = {
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 WebKitGTK/2.44',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36',
};
const PLATFORM = { windows: 'Win32', linux: 'Linux x86_64', mac: 'MacIntel', android: 'Linux armv8l' };

function stub(os: keyof typeof UA, tauri: boolean): void {
  vi.stubGlobal('navigator', { userAgent: UA[os], platform: PLATFORM[os] });
  const listeners: Record<string, Array<() => void>> = {};
  const window: Record<string, unknown> = {
    location: { search: '' },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    addEventListener(t: string, fn: () => void) {
      (listeners[t] ??= []).push(fn);
    },
  };
  if (tauri) window.__TAURI_INTERNALS__ = {};
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', { visibilityState: 'visible', hasFocus: () => true, addEventListener() {} });
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('fetch', async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }));
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  FakeSocket.instances = 0;
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 起動時と同じ決め方で chat を選び、client.start に渡す */
async function startLikeBoot(os: keyof typeof UA, tauri: boolean): Promise<void> {
  stub(os, tauri);
  const { bootChatTransport, currentBootEnv } = await import('../transport/boot');
  const { client } = await import('./client.svelte');
  const base = currentBootEnv();
  const chat = bootChatTransport({
    flag: '0', // 旧の逃げ道。もう見ない（S7）
    desktop: base.desktop,
    android: base.android,
    invoke: vi.fn().mockResolvedValue(null) as never,
    context: base.context,
    log: undefined,
  });
  client.start(chat);
}

describe('S7: no JS Socket on Tauri (Windows, Linux, Android)', () => {
  it.each(['windows', 'linux', 'android'] as const)('%s Tauri: the chat is rust and no socket is created, even with the old "0" flag', async (os) => {
    await startLikeBoot(os, true);
    expect(FakeSocket.instances).toBe(0);
  });
});

describe('the JS socket remains where it is still used', () => {
  it('the browser (dev) creates the socket', async () => {
    await startLikeBoot('windows', false);
    expect(FakeSocket.instances).toBe(1);
  });

  it('macOS Tauri (policy off, out of scope per Q1) keeps the JS socket as before', async () => {
    await startLikeBoot('mac', true);
    expect(FakeSocket.instances).toBe(1);
  });
});
