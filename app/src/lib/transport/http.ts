import type { ApiError } from '../protocol/ApiError';
import { apiUrl, authHeaders } from '../config';
import { HttpError } from './httpError';

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

/**
 * 届かなかった通信（応答がない・つながらない）。Rust 経路の timeout / network と同じ意味。
 * HttpError ではない（プラグインの disconnected の判断・HTTP のエラーの文と分けるため）
 */
export class ConnectionError extends Error {
  constructor(
    public kind: 'timeout' | 'network',
    message: string,
  ) {
    super(message);
    this.name = 'ConnectionError';
  }
}

/** 読み取りの上限時間（ms）。つながらない相手に、WebView は数十秒〜無限に待つことがあるため */
export const READ_TIMEOUT_MS = 15_000;

/** 読み取り用（時間で打ち切る）。書込には付けない（送信の結果が分からなくなるため） */
export const READ: RequestOptions = { timeoutMs: READ_TIMEOUT_MS };

export type RequestOptions = { timeoutMs?: number };

/**
 * 通信をひとまとめに行う。timeoutMs があれば、応答の本文まで含めてその時間で打ち切る。
 * fetch が届かなかった（TypeError）ときは ConnectionError('network') にする
 */
async function exchange<T>(timeoutMs: number | undefined, task: (signal?: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = timeoutMs === undefined ? undefined : new AbortController();
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : undefined;
  try {
    return await task(ctl?.signal);
  } catch (e) {
    if (ctl?.signal.aborted) throw new ConnectionError('timeout', `応答がありません（${Math.round((timeoutMs ?? 0) / 1000)} 秒）`);
    if (e instanceof TypeError) throw new ConnectionError('network', 'サーバーに届きませんでした');
    throw e;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function request<T>(method: string, path: string, body?: unknown, base?: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...authHeaders() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const url = (base ?? '') + (base !== undefined ? path : apiUrl(path));
  return exchange(opts.timeoutMs, async (signal) => {
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
    if (!res.ok) throw await toError(res);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  });
}

export function qs(params: Record<string, string | number | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? '?' + s : '';
}
