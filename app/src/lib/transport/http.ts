import type { ApiError } from '../protocol/ApiError';
import { apiUrl, authHeaders } from '../config';
import { errorText } from '../errors';
import type { ReadApi } from './types';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(errorText(code, message));
  }
}

export async function toError(res: Response): Promise<HttpError> {
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

export async function request<T>(method: string, path: string, body?: unknown, base?: string): Promise<T> {
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

export function qs(params: Record<string, string | number | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? '?' + s : '';
}

/** 従来の fetch 経路。読取メソッドの HTTP 実装（api.ts の既定） */
export function createHttpReadApi(): ReadApi {
  return {
    me: () => request('GET', '/api/me'),
    users: () => request('GET', '/api/users'),
    prefs: () => request('GET', '/api/me/prefs'),
    messages: (opts) =>
      request('GET', '/api/messages' + qs({ thread_id: opts.threadId, before: opts.before, limit: opts.limit })),
    searchMessages: (opts) =>
      request('GET', '/api/messages/search' + qs({ q: opts.q, before: opts.before, limit: opts.limit })),
    threads: () => request('GET', '/api/threads'),
    thread: (id) => request('GET', `/api/threads/${encodeURIComponent(id)}`),
    threadTags: () => request('GET', '/api/thread-tags'),
    readMarkers: () => request('GET', '/api/me/read'),
    plugins: () => request('GET', '/api/plugins'),
    session: (id) => request('GET', `/api/sessions/${encodeURIComponent(id)}`),
  };
}
