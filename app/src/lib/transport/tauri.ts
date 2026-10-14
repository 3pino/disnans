import { HttpError } from './http';
import type { InvokeArgs, InvokeOptions as TauriInvokeOptions } from '@tauri-apps/api/core';
import type { ApiBridgeError, BridgeContext, Invoke, InvokeOptions, ReadApi } from './types';

/** `@tauri-apps/api/core` を使う invoke（遅延 import。Tauri 以外では呼ばれない） */
export const tauriInvoke: Invoke = async <T>(command: string, args?: Record<string, unknown> | Uint8Array, options?: InvokeOptions) => {
  const { invoke } = await import('@tauri-apps/api/core');
  // Tauri の型は headers を HeadersInit で受ける。ここでは Record<string, string> だけを渡す
  return invoke<T>(command, args as InvokeArgs | undefined, options as TauriInvokeOptions | undefined);
};

/** Tauri コマンドの reject 値を、従来の HttpError と同じ形にする */
export function toBridgeError(e: unknown): HttpError {
  if (e && typeof e === 'object') {
    const b = e as Partial<ApiBridgeError>;
    if (typeof b.code === 'string' && typeof b.message === 'string') {
      return new HttpError(typeof b.status === 'number' ? b.status : 0, b.code, b.message);
    }
  }
  return new HttpError(0, 'bridge_error', typeof e === 'string' ? e : 'ネットワークエラー');
}

/** 読取 REST の Tauri 実装（ステップ4 段1）。コマンドは .pi/step4-ipc-contract.md §3 のとおり */
export function createTauriReadApi(invoke: Invoke, ctx: BridgeContext): ReadApi {
  const call = async <T>(command: string, extra: Record<string, unknown> = {}): Promise<T> => {
    try {
      return await invoke<T>(command, { args: { server: ctx.server(), devUser: ctx.devUser, ...extra } });
    } catch (e) {
      throw toBridgeError(e);
    }
  };
  return {
    me: () => call('api_me'),
    users: () => call('api_users'),
    prefs: () => call('api_prefs'),
    messages: (opts) =>
      call('api_messages', { threadId: opts.threadId ?? null, before: opts.before ?? null, limit: opts.limit ?? null }),
    searchMessages: (opts) =>
      call('api_search_messages', { q: opts.q, before: opts.before ?? null, limit: opts.limit ?? null }),
    threads: () => call('api_threads'),
    thread: (id) => call('api_thread', { id }),
    threadTags: () => call('api_thread_tags'),
    readMarkers: () => call('api_read_markers'),
    plugins: () => call('api_plugins'),
    session: (id) => call('api_session', { id }),
  };
}
