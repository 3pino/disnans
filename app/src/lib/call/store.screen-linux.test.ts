// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { CallStore } from './store.svelte';
import { CallSettings, createCallSource } from './settings.svelte';
import { FakeNativePort, snap } from '../../test-support/nativeFake';
import type { ScreenCapturePort } from './screen/types';

it('Linux の取得は実際の本体 Sender へ渡し、開始応答より早い最初のフレームも送る', async () => {
  const port = new FakeNativePort();
  const frame = { data: '/9j/QUJD', mime: 'image/jpeg', width: 2, height: 2 };
  const capture: ScreenCapturePort = {
    supported: true, supportsCallRelay: false,
    start: vi.fn(async (_opts, callback) => { callback(frame); }),
    stop: vi.fn(async () => {}), update: vi.fn(async () => {}), snapshot: vi.fn(),
  };
  // 音声経路は FakeNativePort、Linux の映像経路は本物の ScreenSender。OS の取得は行わない。
  const store = new CallStore({
    native: port, serverUrl: () => 'http://synthetic.test', send: vi.fn(), meId: () => 'me', nameOf: (id) => id,
    toast: vi.fn(), confirm: async () => true, hold: vi.fn(),
    audio: { listOutputs: async () => [], listInputs: async () => [], setOutput: async () => true, attach: () => () => {} },
    settings: new CallSettings(createCallSource()), deviceKind: () => 'laptop', openSettings: () => {}, now: () => performance.now(),
    screen: { capture, toast: vi.fn(), settings: { value: { fps: 5, quality: 'p720', color: 'full' }, patch: vi.fn(), subscribe: () => () => {} } },
  });
  try {
    await store.join();
    const session = port.starts[0].session;
    port.pushState(snap({ session, phase: 'joined', wanted: true, listed: true, peer: 'self', generation: 2, seq: 1,
      members: ['self', 'other'].map((peer) => ({ peer, user_id: peer === 'self' ? 'me' : 'other-user', status: { muted: false, deafened: false, device: 'laptop' } })) }));
    for (let i = 0; i < 12; i++) await Promise.resolve();
    await store.screen!.toggleScreen();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(store.screen!.sharing).toBe(true);
    expect(port.emits.some(([, name, payload]) => name === 'screen.frame' && (payload as { d: string }).d === frame.data)).toBe(true);
    expect(capture.start).toHaveBeenCalledWith(expect.not.objectContaining({ callRelay: expect.anything() }), expect.any(Function));
  } finally { store.screen?.dispose(); store.leave(); }
});
