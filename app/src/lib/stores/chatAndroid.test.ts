import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatItem, ChatTransport, MessageDraft, SendOutcome } from '../transport/chat';

// Android（opt-in の rust チャット）: 復帰（visibilitychange→visible）とネットワーク変化（online）で chat_start（作り直し）。
// 既定（JS Socket）や Windows/Linux では、これらの購読を増やさない。

class FakeChat implements ChatTransport {
  starts = 0;
  reconnects = 0;
  startHold: Promise<void> | null = null;
  async start(_onItem: (item: ChatItem) => void): Promise<void> {
    this.starts++;
    if (this.startHold) await this.startHold;
  }
  async send(_d: MessageDraft): Promise<SendOutcome> {
    return { outcome: 'notSent', reason: 'x' };
  }
  async reconnect(): Promise<void> {
    this.reconnects++;
  }
  async stop(): Promise<void> {}
  async emit(): Promise<void> {}
}

class FakeSocket {
  static instances = 0;
  constructor() {
    FakeSocket.instances++;
  }
  close() {}
}

type Listener = () => void;

function env(ua: string, tauri: boolean) {
  const winL: Record<string, Listener[]> = {};
  const docL: Record<string, Listener[]> = {};
  const doc = {
    visibilityState: 'visible' as 'visible' | 'hidden',
    hasFocus: () => true,
    addEventListener(t: string, fn: Listener) {
      (docL[t] ??= []).push(fn);
    },
  };
  vi.stubGlobal('navigator', { userAgent: ua, platform: '' });
  vi.stubGlobal('window', {
    ...(tauri ? { __TAURI_INTERNALS__: {} } : {}),
    addEventListener(t: string, fn: Listener) {
      (winL[t] ??= []).push(fn);
    },
    location: { search: '' },
  });
  vi.stubGlobal('document', doc);
  vi.stubGlobal('WebSocket', FakeSocket);
  return {
    doc,
    fireWindow: (t: string) => (winL[t] ?? []).forEach((f) => f()),
    fireDoc: (t: string) => (docL[t] ?? []).forEach((f) => f()),
  };
}

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 9) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';
const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36';

const flush = () => new Promise((r) => setTimeout(r, 0));
let client: typeof import('./client.svelte').client;

beforeEach(async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('fetch', async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.resetModules();
  FakeSocket.instances = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Android chat: resume and network change restart the chat (chat_start, not chat_reconnect)', () => {
  it('visible again restarts the chat once, with no JS socket', async () => {
    const e = env(ANDROID_UA, true);
    ({ client } = await import('./client.svelte'));
    const chat = new FakeChat();
    client.start(chat);
    await flush();
    expect(chat.starts).toBe(1);
    e.doc.visibilityState = 'hidden';
    e.fireDoc('visibilitychange');
    expect(chat.starts).toBe(1);
    e.doc.visibilityState = 'visible';
    e.fireDoc('visibilitychange');
    await flush();
    expect(chat.starts).toBe(2);
    expect(chat.reconnects).toBe(0);
    expect(FakeSocket.instances).toBe(0);
  });

  it('online restarts the chat (network change)', async () => {
    const e = env(ANDROID_UA, true);
    ({ client } = await import('./client.svelte'));
    const chat = new FakeChat();
    client.start(chat);
    await flush();
    e.fireWindow('online');
    await flush();
    expect(chat.starts).toBe(2);
  });

  it('does not start a second time while a start is still running', async () => {
    const e = env(ANDROID_UA, true);
    ({ client } = await import('./client.svelte'));
    const chat = new FakeChat();
    let release!: () => void;
    chat.startHold = new Promise<void>((r) => (release = r));
    client.start(chat);
    e.fireWindow('online');
    e.doc.visibilityState = 'visible';
    e.fireDoc('visibilitychange');
    expect(chat.starts).toBe(1);
    release();
    await flush();
    expect(chat.starts).toBe(1);
  });

  it('Linux desktop: resume and online do not restart the chat (the desktop default is unchanged)', async () => {
    const e = env(LINUX_UA, true);
    ({ client } = await import('./client.svelte'));
    const chat = new FakeChat();
    client.start(chat);
    await flush();
    e.fireWindow('online');
    e.fireDoc('visibilitychange');
    await flush();
    expect(chat.starts).toBe(1);
  });

  it('an Android browser (not Tauri): no restart, and the JS socket is created as before', async () => {
    const e = env(ANDROID_UA, false);
    ({ client } = await import('./client.svelte'));
    client.start(null);
    e.fireWindow('online');
    e.fireDoc('visibilitychange');
    expect(FakeSocket.instances).toBe(1);
  });
});
