// Android の通話（ネイティブ所有）の橋（Tauri の notifier プラグイン）。本番だけで使う。
// notifier のコマンド名は native_call_*（snake case）。開始の引数は平らな項目（封筒なし）。イベントは 'call_native'。

import type { NativeCallPort, NativeEvent, NativeSnapshot } from './native';

const PLUGIN = 'notifier';
const EVENT = 'call_native';

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: call } = await import('@tauri-apps/api/core');
  return call<T>(`plugin:${PLUGIN}|${cmd}`, args);
}

export function createTauriNativePort(): NativeCallPort {
  return {
    start: (args) => invoke<NativeSnapshot>('native_call_start', { ...args }),
    stop: (session, reason) => invoke<void>('native_call_stop', { session, reason }),
    snapshot: () => invoke<NativeSnapshot>('native_call_snapshot'),
    control: (session, patch) => invoke<void>('native_call_control', { session, patch }),
    kick: (session, peer) => invoke<void>('native_call_kick', { session, peer }),
    emit: (session, name, payload) => invoke<void>('native_call_emit', { session, name, payload }),
    listen: async (cb) => {
      const { addPluginListener } = await import('@tauri-apps/api/core');
      const listener = await addPluginListener<NativeEvent>(PLUGIN, EVENT, (ev) => cb(ev));
      let off = false;
      return () => {
        if (off) return;
        off = true;
        void listener.unregister().catch(() => console.warn('[call] 通話の受け取りを外せませんでした'));
      };
    },
  };
}
