import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionError, READ, READ_TIMEOUT_MS, request } from './http';

// 読み取りは時間で打ち切る（つながらない相手に無限に待たない）。書込は打ち切らない（送信の結果が分からなくなるため）

/** 応答の無い fetch（永久に pending）。signal が中止されたら、fetch と同じく AbortError で拒む */
function pendingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
}

/** 応答は届くが、本文が途中で止まる（ヘッダーは来たのに中身が来ない） */
function stalledBodyFetch(): ReturnType<typeof vi.fn> {
  return vi.fn((_url: string, init?: RequestInit) => {
    const res = { ok: true, status: 200, json: () => new Promise((_r, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }) };
    return Promise.resolve(res);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** 結果（成功・失敗）を、待たずに記録する */
function track<T>(p: Promise<T>): { settled: () => 'pending' | 'ok' | 'error'; error: () => unknown } {
  const state: { s: 'pending' | 'ok' | 'error'; e?: unknown } = { s: 'pending' };
  p.then(() => (state.s = 'ok'), (e: unknown) => {
    state.s = 'error';
    state.e = e;
  });
  return { settled: () => state.s, error: () => state.e };
}

describe('読み取りの上限時間', () => {
  it('応答が無いまま 15 秒経つと、接続の失敗（timeout）になる。それまでは待つ', async () => {
    vi.stubGlobal('fetch', pendingFetch());
    const r = track(request('GET', '/api/me', undefined, 'http://srv.test', READ));
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - 100);
    expect(r.settled()).toBe('pending');
    await vi.advanceTimersByTimeAsync(200);
    expect(r.settled()).toBe('error');
    expect(r.error()).toBeInstanceOf(ConnectionError);
    expect((r.error() as ConnectionError).kind).toBe('timeout');
    expect((r.error() as ConnectionError).message).toContain('応答がありません');
  });

  it('本文が途中で止まったときも、同じく時間で打ち切る', async () => {
    vi.stubGlobal('fetch', stalledBodyFetch());
    const r = track(request('GET', '/api/messages', undefined, 'http://srv.test', READ));
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS + 10);
    expect(r.settled()).toBe('error');
    expect((r.error() as ConnectionError).kind).toBe('timeout');
  });

  it('fetch が届かなかった（TypeError）ときは、すぐ network の接続の失敗にする', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    const r = track(request('GET', '/api/me', undefined, 'http://srv.test', READ));
    await vi.advanceTimersByTimeAsync(0);
    expect(r.settled()).toBe('error');
    expect((r.error() as ConnectionError).kind).toBe('network');
  });

  it('成功した読み取りは、そのまま値を返す（時間の打ち切りは効かない）', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => ({ id: 'u1' }) })));
    const r = track(request('GET', '/api/me', undefined, 'http://srv.test', READ));
    await vi.advanceTimersByTimeAsync(0);
    expect(r.settled()).toBe('ok');
  });

  it('HTTP のエラー（応答はあった）は、接続の失敗にしない（従来どおり HttpError）', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({ code: 'unauthorized', message: 'x' }) })));
    const r = track(request('GET', '/api/me', undefined, 'http://srv.test', READ));
    await vi.advanceTimersByTimeAsync(0);
    expect(r.error()).not.toBeInstanceOf(ConnectionError);
    expect((r.error() as { status?: number }).status).toBe(401);
  });
});

describe('書込には上限時間を付けない', () => {
  it('応答が遅くても、書込は途中で打ち切らない（送信の結果を確かめられなくなるため）', async () => {
    vi.stubGlobal('fetch', pendingFetch());
    const r = track(request('POST', '/api/messages', { body: 'x' }, 'http://srv.test'));
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS * 4);
    expect(r.settled()).toBe('pending');
  });
});
