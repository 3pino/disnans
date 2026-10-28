// チャットの起動（boot）と client.start。JS の WebSocket は無い（ブラウザー版は廃止）。
// Rust のチャットを持つ Tauri（Windows・Linux・Android）は、chat_start を invoke で呼ぶ（WebSocket は作らない）。
// 対象外の OS はチャットを使えない（接続せず、理由を出す）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { injectedPlatform, stubTauri, type TauriOs } from '../testing/tauriEnv';

class FakeWebSocket {
  static instances = 0;
  constructor() {
    FakeWebSocket.instances++;
  }
  close() {}
  start() {}
  send() {
    return false;
  }
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  FakeWebSocket.instances = 0;
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 起動と同じ決め方（client.start() の既定の boot）で、Tauri の環境の client を作る */
async function bootClient(os: TauriOs) {
  const tauri = stubTauri({ os, inject: injectedPlatform(os) });
  const { client } = await import('./client.svelte');
  return { tauri, client };
}

/** chat_start が呼ばれたか（invoke は動的 import の後で記録されるので、非同期に待つ） */
function chatStartCalls(tauri: { calls: { command: string }[] }): number {
  return tauri.calls.filter((c) => c.command === 'chat_start').length;
}

describe('Rust のチャットを持つ Tauri（Windows・Linux・Android）', () => {
  it.each(['windows', 'linux', 'android'] as const)('%s: chat_start を invoke で呼び、WebSocket は作らない', async (os) => {
    const { tauri, client } = await bootClient(os);
    client.start();
    await vi.waitFor(() => expect(chatStartCalls(tauri)).toBe(1));
    expect(FakeWebSocket.instances).toBe(0);
  });

  it('start を 2 回呼んでも、チャットは 1 回だけ始まる（同期に数える）', async () => {
    // startChat は chat.start を同期に呼ぶ。実際の invoke は動的 import の後に記録されるので、ここでは transport の start で数える
    const { client } = await bootClient('windows');
    let starts = 0;
    const chat = { start: async () => void starts++, send: async () => ({ outcome: 'notSent', reason: 'x' }), reconnect: async () => {}, stop: async () => {}, emit: async () => {} };
    client.start(chat as never);
    client.start(chat as never);
    expect(starts).toBe(1);
  });
});

describe('対象外の OS（Tauri の Rust チャットを持たない）', () => {
  it('チャットは無い: 接続せず、理由を出し、送信は false（キューに積まない）。WebSocket も作らない', async () => {
    const { tauri, client } = await bootClient('other');
    client.start();
    expect(tauri.calls).toEqual([]);
    expect(client.status).toBe('closed');
    expect(client.linkReason).toBe('この環境ではチャットを使えません');
    expect(client.send({ type: 'message.send', client_id: 'c', body: 'hi', attachment_ids: [], reply_to: null, silent: false } as never)).toBe(false);
    expect(FakeWebSocket.instances).toBe(0);
  });
});
