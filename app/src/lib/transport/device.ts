import type { BridgeContext, Invoke } from './types';
import { toBridgeError } from './tauri';

/** 端末の設定の結果。`saved` が false は「まだ設定が無い」（既定の値を返す） */
export type DeviceView = { prefs: Record<string, unknown>; updatedAt: number | null; saved: boolean };

/** 端末（この端末の ID・登録・設定）の口。Tauri（Rust の api_device_*）だけ */
export type DeviceApi = {
  /** この端末の ID（Rust の LocalStore が決める。無ければ作る） */
  id(): Promise<string>;
  /** 端末の登録（初回は作る。名前の変更も同じ） */
  register(id: string, name: string): Promise<void>;
  /** 端末の設定を読む（未登録・設定なしは saved: false と既定値） */
  read(id: string): Promise<DeviceView>;
  /** 端末の設定をまるごと書く（Rust で正規化したものが返る） */
  write(id: string, body: Record<string, unknown>): Promise<DeviceView>;
};

/** Rust の api_device_* を呼ぶ口（引数は server・devUser・id の形）。エラーは HttpError にそろえる */
export function createDeviceApi(invoke: Invoke, ctx: BridgeContext): DeviceApi {
  const call = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    try {
      return await invoke<T>(command, args);
    } catch (e) {
      throw toBridgeError(e);
    }
  };
  const base = () => ({ server: ctx.server(), devUser: ctx.devUser });
  return {
    id: () => call<string>('client_device_id'),
    register: async (id, name) => {
      await call('api_device_register', { args: { ...base(), id, name } });
    },
    read: (id) => call<DeviceView>('api_device_prefs_read', { args: { ...base(), id } }),
    write: (id, body) => call<DeviceView>('api_device_prefs_write', { args: { ...base(), id, body } }),
  };
}
