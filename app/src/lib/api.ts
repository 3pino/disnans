import type { ApiError } from './protocol/ApiError';
import type { Attachment } from './protocol/Attachment';
import type { Message } from './protocol/Message';
import type { Thread } from './protocol/Thread';
import type { UpdateMe } from './protocol/UpdateMe';
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
  users: () => request<User[]>('GET', '/api/users'),
  messages: (opts: { threadId?: string | null; before?: string | null; limit?: number }) =>
    request<Message[]>(
      'GET',
      '/api/messages' + qs({ thread_id: opts.threadId, before: opts.before, limit: opts.limit }),
    ),
  threads: () => request<Thread[]>('GET', '/api/threads'),
  thread: (id: string) => request<Thread>('GET', `/api/threads/${encodeURIComponent(id)}`),
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
