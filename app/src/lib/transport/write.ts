import type { CreateSession } from '../protocol/CreateSession';
import type { MarkRead } from '../protocol/MarkRead';
import type { Message } from '../protocol/Message';
import type { PluginInfo } from '../protocol/PluginInfo';
import type { PluginNotify } from '../protocol/PluginNotify';
import type { PluginPostMessage } from '../protocol/PluginPostMessage';
import type { PluginVisibility } from '../protocol/PluginVisibility';
import type { ReadMarker } from '../protocol/ReadMarker';
import type { Session } from '../protocol/Session';
import type { Thread } from '../protocol/Thread';
import type { ThreadTag } from '../protocol/ThreadTag';
import type { UpdateMe } from '../protocol/UpdateMe';
import type { UpdateSession } from '../protocol/UpdateSession';
import type { UpdateThread } from '../protocol/UpdateThread';
import type { User } from '../protocol/User';
import { apiUrl, authHeaders } from '../config';
import { HttpError, request, toError } from './http';
import { toBridgeError } from './tauri';
import type { BridgeContext, Invoke } from './types';

/**
 * 書込 REST の経路（契約 .pi/step4-ipc-contract.md §9）。`api` の書込メソッドと同じ引数・戻り値。
 *
 * 原則（二重送信防止）:
 * - 自動リトライはしない。失敗は呼び出し元へ返す。
 * - 非冪等の書込（NON_IDEMPOTENT に挙げたもの）は、status の無い失敗（接続前・送信後の区別なし）を
 *   結果不明（UNKNOWN_OUTCOME）として返す。成功にも未送信にもしない。
 */
export interface WriteApi {
  updateMe(body: UpdateMe): Promise<User>;
  setAvatar(file: Blob, fileName: string): Promise<User>;
  clearAvatar(): Promise<User>;
  setPrefs(prefs: Record<string, unknown>): Promise<Record<string, unknown>>;
  updateThread(id: string, body: UpdateThread): Promise<Thread>;
  setThreadTags(id: string, tags: ThreadTag[]): Promise<Thread>;
  sampleNotification(): Promise<void>;
  markRead(body: MarkRead): Promise<ReadMarker>;
  deletePlugin(id: string): Promise<void>;
  publishPlugin(files: { name: string; data: Blob }[], visibility: PluginVisibility): Promise<PluginInfo>;
  pluginPostMessage(id: string, body: PluginPostMessage): Promise<Message>;
  pluginNotify(id: string, body: PluginNotify): Promise<void>;
  createSession(body: CreateSession): Promise<Session>;
  updateSession(id: string, body: UpdateSession): Promise<Session>;
}

/** 非冪等の書込で、結果が分からない失敗の code（表示文は errors.ts） */
export const UNKNOWN_OUTCOME = 'unknown_outcome';

/** 非冪等の書込（同じ要求を二度送ると二度効く）。status の無い失敗は UNKNOWN_OUTCOME になる */
export const NON_IDEMPOTENT = new Set(['sampleNotification', 'publishPlugin', 'pluginPostMessage', 'pluginNotify', 'createSession']);

/** HTTP の経路（従来の fetch。挙動は変えない） */
export function createHttpWriteApi(): WriteApi {
  return {
    updateMe: (body) => request<User>('PATCH', '/api/me', body),
    setAvatar: async (file, fileName) => {
      const fd = new FormData();
      fd.append('file', file, fileName);
      const res = await fetch(apiUrl('/api/me/avatar'), { method: 'PUT', headers: authHeaders(), body: fd });
      if (!res.ok) throw await toError(res);
      return (await res.json()) as User;
    },
    clearAvatar: () => request<User>('DELETE', '/api/me/avatar'),
    setPrefs: (prefs) => request<Record<string, unknown>>('PUT', '/api/me/prefs', prefs),
    updateThread: (id, body) => request<Thread>('PATCH', `/api/threads/${encodeURIComponent(id)}`, body),
    setThreadTags: (id, tags) => request<Thread>('PUT', `/api/threads/${encodeURIComponent(id)}/tags`, { tags }),
    sampleNotification: () => request<void>('POST', '/api/notify/sample'),
    markRead: (body) => request<ReadMarker>('PUT', '/api/me/read', body),
    deletePlugin: (id) => request<void>('DELETE', `/api/plugins/${encodeURIComponent(id)}`),
    publishPlugin: async (files, visibility = 'public') => {
      const fd = new FormData();
      fd.append('visibility', visibility);
      for (const f of files) fd.append('file', f.data, f.name);
      const res = await fetch(apiUrl('/api/plugins'), { method: 'POST', headers: authHeaders(), body: fd });
      if (!res.ok) throw await toError(res);
      return (await res.json()) as PluginInfo;
    },
    pluginPostMessage: (id, body) => request<Message>('POST', `/api/plugins/${encodeURIComponent(id)}/messages`, body),
    pluginNotify: (id, body) => request<void>('POST', `/api/plugins/${encodeURIComponent(id)}/notify`, body),
    createSession: (body) => request<Session>('POST', '/api/sessions', body),
    updateSession: (id, body) => request<Session>('PUT', `/api/sessions/${encodeURIComponent(id)}`, body),
  };
}

/** raw body の付随情報（契約 §9.3）: ヘッダー x-disnans-args = encodeURIComponent(JSON.stringify(args)) */
export function argsHeader(args: Record<string, unknown>): Record<string, string> {
  return { 'x-disnans-args': encodeURIComponent(JSON.stringify(args)) };
}

/** 送信前に止まったことが分かる失敗（非冪等でも結果不明ではない） */
const PRE_SEND_CODES = new Set(['network', 'timeout', 'invalid_request']);

/** 書込の reject を HttpError にする。非冪等で status が無く、送信前と分からないものは結果不明 */
export function writeError(e: unknown, nonIdempotent: boolean): HttpError {
  const err = toBridgeError(e);
  if (nonIdempotent && err.status === 0 && !PRE_SEND_CODES.has(err.code)) {
    return new HttpError(0, UNKNOWN_OUTCOME, '結果を確認できませんでした。二重投稿を防ぐため自動では再送していません');
  }
  return err;
}

/** 書込 REST の Tauri 実装。コマンド名は契約 §9.2（添付・アバター・公開は §9.3 の raw body） */
export function createTauriWriteApi(invoke: Invoke, ctx: BridgeContext): WriteApi {
  const call = async <T>(command: string, extra: Record<string, unknown>, nonIdempotent: boolean): Promise<T> => {
    try {
      return await invoke<T>(command, { args: { server: ctx.server(), devUser: ctx.devUser, ...extra } });
    } catch (e) {
      throw writeError(e, nonIdempotent);
    }
  };
  // raw body（§9.3）: バイト列は raw body、メタは x-disnans-args ヘッダー
  const raw = async <T>(command: string, body: Uint8Array, extra: Record<string, unknown>, nonIdempotent: boolean): Promise<T> => {
    try {
      return await invoke<T>(command, body, { headers: argsHeader({ server: ctx.server(), devUser: ctx.devUser, ...extra }) });
    } catch (e) {
      throw writeError(e, nonIdempotent);
    }
  };
  const bytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
  return {
    updateMe: (body) => call('api_update_me', { body }, false),
    setAvatar: async (file, fileName) =>
      raw('api_set_avatar', await bytes(file), { fileName, mime: file.type || null }, false),
    clearAvatar: () => call('api_clear_avatar', {}, false),
    setPrefs: (prefs) => call('api_set_prefs', { body: prefs }, false),
    updateThread: (id, body) => call('api_update_thread', { id, body }, false),
    setThreadTags: (id, tags) => call('api_set_thread_tags', { id, tags }, false),
    sampleNotification: () => call('api_sample_notification', {}, true),
    markRead: (body) => call('api_mark_read', { body }, false),
    deletePlugin: (id) => call('api_delete_plugin', { id }, false),
    publishPlugin: async (files, visibility = 'public') => {
      // 各ファイルを parts の順に1つの raw body へ連結する（size 合計 = 本体の長さ）
      const parts = await Promise.all(files.map((f) => bytes(f.data)));
      const body = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
      let off = 0;
      for (const p of parts) {
        body.set(p, off);
        off += p.byteLength;
      }
      const meta = files.map((f, i) => ({ name: f.name, size: parts[i].byteLength }));
      return raw('api_create_plugin', body, { visibility, parts: meta }, true);
    },
    pluginPostMessage: (id, body) => call('api_plugin_post_message', { id, body }, true),
    pluginNotify: (id, body) => call('api_plugin_notify', { id, body }, true),
    createSession: (body) => call('api_create_session', { body }, true),
    updateSession: (id, body) => call('api_update_session', { id, body }, false),
  };
}
