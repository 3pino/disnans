import { describe, expect, it, vi } from 'vitest';
import { CallStore } from './store.svelte';
import { CallSettings, createCallSource } from './settings.svelte';
import { FakeNativePort } from '../../test-support/nativeFake';
import { NativeCallEngine } from './nativeEngine';
import { WebCallEngine } from './webEngine';

function make(native?: FakeNativePort) {
  return new CallStore({
    native, serverUrl: () => 'http://engine.test', send: vi.fn(), meId: () => 'me', nameOf: (id) => id,
    toast: vi.fn(), confirm: async () => true, hold: vi.fn(),
    audio: { listOutputs: async () => [], listInputs: async () => [], setOutput: async () => true, attach: () => () => {} },
    settings: new CallSettings(createCallSource()), deviceKind: () => 'laptop', openSettings: () => {}, now: () => performance.now(),
  });
}
const engineOf = (s: CallStore) => (s as unknown as { engine: unknown }).engine;

describe('通話のエンジンは作るときに 1 度だけ選ぶ', () => {
  it('native の橋があればネイティブ、無ければ Web', () => {
    const web = make();
    const nat = make(new FakeNativePort());
    expect(engineOf(web)).toBeInstanceOf(WebCallEngine);
    expect(engineOf(nat)).toBeInstanceOf(NativeCallEngine);
    expect(web.nativeOwned).toBe(false);
    expect(nat.nativeOwned).toBe(true);
  });

  it('参加していないときのミュート・スピーカーミュートはどちらも知らせるだけ（エンジンへ渡さない）', () => {
    for (const store of [make(), make(new FakeNativePort())]) {
      store.toggleMute(); store.toggleDeafen();
      expect(store.deps.toast).toHaveBeenCalledTimes(2);
      expect(store.muted).toBe(false);
    }
  });
});
