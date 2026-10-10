import type { ApiError } from './protocol/ApiError';
import type { Attachment } from './protocol/Attachment';
import type { CreateSession } from './protocol/CreateSession';
import type { MarkRead } from './protocol/MarkRead';
import type { Message } from './protocol/Message';
import type { PluginInfo } from './protocol/PluginInfo';
import type { PluginVisibility } from './protocol/PluginVisibility';
import type { PluginNotify } from './protocol/PluginNotify';
import type { PluginPostMessage } from './protocol/PluginPostMessage';
import type { ReadMarker } from './protocol/ReadMarker';
import type { Session } from './protocol/Session';
import type { Thread } from './protocol/Thread';
import type { ThreadTag } from './protocol/ThreadTag';
import type { ThreadTagUsage } from './protocol/ThreadTagUsage';
import type { UpdateThread } from './protocol/UpdateThread';
import type { UpdateMe } from './protocol/UpdateMe';
import type { UpdateSession } from './protocol/UpdateSession';
import type { User } from './protocol/User';
import { apiUrl, authHeaders } from './config';
import { errorText } from './errors';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(errorText(code, message));
  }
}

async function toError(res: Response): Promise<HttpError> {
  let code = 'http_' + res.status;
  let message = res.statusText || `HTTP ${res.status}`;
  try {
    const e = (await res.json()) as ApiError;
    if (e && typeof e.code === 'string') {
      code = e.code;
      message = e.message;
    }
  } catch {
    // JSON でなければそのまま
  }
  return new HttpError(res.status, code, message);
}

async function request<T>(method: string, path: string, body?: unknown, base?: string): Promise<T> {
  const headers: Record<string, string> = { ...authHeaders() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch((base ?? '') + (base !== undefined ? path : apiUrl(path)), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function qs(params: Record<string, string | number | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? '?' + s : '';
}

export const api = {
  me: () => request<User>('GET', '/api/me'),
  /** 初回設定で、保存前のサーバー URL に接続できるか確かめる */
  probe: (base: string) => request<User>('GET', '/api/me', undefined, base),
  updateMe: (body: UpdateMe) => request<User>('PATCH', '/api/me', body),
  /** 自分のアバターを設定する（サーバーで中央を正方形に切り抜き、256px の WebP にする） */
  setAvatar: async (file: Blob, fileName = 'avatar'): Promise<User> => {
    const fd = new FormData();
    fd.append('file', file, fileName);
    const res = await fetch(apiUrl('/api/me/avatar'), { method: 'PUT', headers: authHeaders(), body: fd });
    if (!res.ok) throw await toError(res);
    return (await res.json()) as User;
  },
  /** 自分で設定したアバターを消し、Tailscale のプロフィール画像に戻す */
  clearAvatar: () => request<User>('DELETE', '/api/me/avatar'),
  /** 自分の設定（端末をまたいで共有する。中身はクライアントが決める JSON オブジェクト） */
  prefs: () => request<Record<string, unknown>>('GET', '/api/me/prefs'),
  setPrefs: (prefs: Record<string, unknown>) => request<Record<string, unknown>>('PUT', '/api/me/prefs', prefs),
  users: () => request<User[]>('GET', '/api/users'),
  messages: (opts: { threadId?: string | null; before?: string | null; limit?: number }) =>
    request<Message[]>(
      'GET',
      '/api/messages' + qs({ thread_id: opts.threadId, before: opts.before, limit: opts.limit }),
    ),
  threads: () => request<Thread[]>('GET', '/api/threads'),
  thread: (id: string) => request<Thread>('GET', `/api/threads/${encodeURIComponent(id)}`),
  /** タイトル・アーカイブを変える（スレッドを立てた人だけ） */
  updateThread: (id: string, body: UpdateThread) => request<Thread>('PATCH', `/api/threads/${encodeURIComponent(id)}`, body),
  /** タグを置き換える（誰でも） */
  setThreadTags: (id: string, tags: ThreadTag[]) => request<Thread>('PUT', `/api/threads/${encodeURIComponent(id)}/tags`, { tags }),
  /** すでに使われているタグ（多い順） */
  threadTags: () => request<ThreadTagUsage[]>('GET', '/api/thread-tags'),
  /** 自分にサンプルの通知を送る */
  sampleNotification: () => request<void>('POST', '/api/notify/sample'),
  /** 既読の位置と未読数（メインチャットが先頭、続いてすべてのスレッド） */
  readMarkers: () => request<ReadMarker[]>('GET', '/api/me/read'),
  /** 既読の位置を進める（戻らない） */
  markRead: (body: MarkRead) => request<ReadMarker>('PUT', '/api/me/read', body),

  // ---- プラグイン ----
  plugins: () => request<PluginInfo[]>('GET', '/api/plugins'),
  /** 配布・更新。files は manifest.json / main.js / styles.css / theme.css / icon.svg（ファイル名で見分ける） */
  publishPlugin: async (files: { name: string; data: Blob }[], visibility: PluginVisibility = 'public'): Promise<PluginInfo> => {
    const fd = new FormData();
    fd.append('visibility', visibility);
    for (const f of files) fd.append('file', f.data, f.name);
    const res = await fetch(apiUrl('/api/plugins'), { method: 'POST', headers: authHeaders(), body: fd });
    if (!res.ok) throw await toError(res);
    return (await res.json()) as PluginInfo;
  },
  deletePlugin: (id: string) => request<void>('DELETE', `/api/plugins/${encodeURIComponent(id)}`),
  /** 配布されたファイルの中身（hash を付けてキャッシュを区別する） */
  pluginFile: async (id: string, name: string, hash: string): Promise<string> => {
    const res = await fetch(apiUrl(`/api/plugins/${encodeURIComponent(id)}/files/${encodeURIComponent(name)}${qs({ v: hash })}`), {
      headers: authHeaders(),
    });
    if (!res.ok) throw await toError(res);
    return await res.text();
  },
  pluginPostMessage: (id: string, body: PluginPostMessage) => request<Message>('POST', `/api/plugins/${encodeURIComponent(id)}/messages`, body),
  pluginNotify: (id: string, body: PluginNotify) => request<void>('POST', `/api/plugins/${encodeURIComponent(id)}/notify`, body),

  // ---- セッション ----
  createSession: (body: CreateSession) => request<Session>('POST', '/api/sessions', body),
  session: (id: string) => request<Session>('GET', `/api/sessions/${encodeURIComponent(id)}`),
  /** version が合わなければ 409 version_conflict */
  updateSession: (id: string, body: UpdateSession) => request<Session>('PUT', `/api/sessions/${encodeURIComponent(id)}`, body),
};

export type UploadHandle = { promise: Promise<Attachment>; abort: () => void };

/** 進捗を取るため XHR でアップロードする */
export function uploadFile(file: File, onProgress?: (ratio: number) => void): UploadHandle {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<Attachment>((resolve, reject) => {
    xhr.open('POST', apiUrl('/api/files'));
    for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as Attachment);
        } catch {
          reject(new HttpError(xhr.status, 'bad_response', 'サーバーの応答を読めませんでした'));
        }
      } else {
        let code = 'http_' + xhr.status;
        let message = `HTTP ${xhr.status}`;
        try {
          const e = JSON.parse(xhr.responseText) as ApiError;
          code = e.code;
          message = e.message;
        } catch {
          // そのまま
        }
        reject(new HttpError(xhr.status, code, message));
      }
    };
    xhr.onerror = () => reject(new HttpError(0, 'network', 'ネットワークエラー'));
    xhr.onabort = () => reject(new HttpError(0, 'aborted', '中止しました'));
    const fd = new FormData();
    fd.append('file', file, file.name);
    xhr.send(fd);
  });
  return { promise, abort: () => xhr.abort() };
}
