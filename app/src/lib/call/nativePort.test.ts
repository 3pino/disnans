// Tauri の橋の境界。コマンド名・引数の形（平ら）・購読の後始末を確かめる
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke, addPluginListener } = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, _args?: unknown) => undefined as unknown),
  addPluginListener: vi.fn(async (_p: string, _e: string, _cb: (v: unknown) => void) => ({ unregister: vi.fn(async () => {}) })),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke, addPluginListener }));

import { createTauriNativePort } from './nativePort';

const P = 'plugin:notifier|';

beforeEach(() => {
  invoke.mockClear();
  addPluginListener.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const settings = { micVolume: 1, outVolume: 1, limiter: true, limitDb: -3, rawInput: false, outputId: null };

describe('nativePort（Tauri の橋の引数の形）', () => {
  it('開始は、平らな項目で頼む（封筒 {args} は付けない）', async () => {
    const port = createTauriNativePort();
    const start = {
      session: 'S',
      serverUrl: 'http://srv.test',
      expectedUserId: 'me',
      devUser: null,
      status: { muted: false, deafened: false, device: 'laptop' },
      settings,
      localMuted: [],
    };
    await port.start(start);
    expect(invoke).toHaveBeenCalledWith(`${P}native_call_start`, start);
    expect(invoke.mock.calls[0]![1]).not.toHaveProperty('args');
  });

  it('停止・操作・外す・送るは、それぞれ決まった名前と項目で頼む', async () => {
    const port = createTauriNativePort();
    await port.stop('S', 'user');
    await port.control('S', { muted: true });
    await port.control('S', { peerMute: { peer: 'p', muted: false } });
    await port.control('S', { settings: { micVolume: 0.5 } });
    await port.kick('S', 'p');
    await port.emit('S', 'game', { a: 1 });
    expect(invoke.mock.calls).toEqual([
      [`${P}native_call_stop`, { session: 'S', reason: 'user' }],
      [`${P}native_call_control`, { session: 'S', patch: { muted: true } }],
      [`${P}native_call_control`, { session: 'S', patch: { peerMute: { peer: 'p', muted: false } } }],
      [`${P}native_call_control`, { session: 'S', patch: { settings: { micVolume: 0.5 } } }],
      [`${P}native_call_kick`, { session: 'S', peer: 'p' }],
      [`${P}native_call_emit`, { session: 'S', name: 'game', payload: { a: 1 } }],
    ]);
  });

  it('読むだけは、引数なしで頼む（開始はしない）', async () => {
    const port = createTauriNativePort();
    await port.snapshot();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]![0]).toBe(`${P}native_call_snapshot`);
  });

  it('購読は notifier の call_native で受け、外すと、その購読を外す（一度だけ）', async () => {
    const port = createTauriNativePort();
    const got: unknown[] = [];
    const off = await port.listen((ev) => got.push(ev));
    expect(addPluginListener).toHaveBeenCalledWith('notifier', 'call_native', expect.any(Function));
    const cb = addPluginListener.mock.calls[0]![2];
    cb({ kind: 'relay', session: 'S', generation: 1, seq: 1, peer: 'p', from: 'u', name: 'g', payload: 1 });
    expect(got).toHaveLength(1);
    const listener = await addPluginListener.mock.results[0]!.value;
    off();
    off();
    expect(listener.unregister).toHaveBeenCalledTimes(1);
  });
});
