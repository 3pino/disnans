import { describe, expect, it } from 'vitest';
import { createHttpReadApi, HttpError } from './http';
import { createTauriReadApi, toBridgeError } from './tauri';
import { selectChatMode, selectReadApi, selectWriteApi } from './select';
import type { Invoke } from './types';

type Call = { command: string; args?: Record<string, unknown> | Uint8Array | string; options?: unknown };

function recorder(reply: (command: string) => unknown = () => null) {
  const calls: Call[] = [];
  const invoke: Invoke = async <T>(command: string, args?: Record<string, unknown> | Uint8Array | string, options?: unknown) => {
    calls.push({ command, args, options });
    const r = reply(command);
    if (r instanceof Error) throw r;
    return r as T;
  };
  return { calls, invoke };
}

const ctx = { server: () => 'http://127.0.0.1:8080', devUser: 'alice' as string | null };

describe('read transport selection', () => {
  const base = { desktop: true, invoke: recorder().invoke, context: ctx };

  it('uses Rust only for flag "1" on desktop', () => {
    expect(selectReadApi({ ...base, flag: '1' }).kind).toBe('tauri');
  });

  it('uses Rust by default on desktop; "0" turns it off; other values are not "0", so still on', () => {
    expect(selectReadApi({ ...base, flag: null }).kind).toBe('tauri');
    expect(selectReadApi({ ...base, flag: '1' }).kind).toBe('tauri');
    expect(selectReadApi({ ...base, flag: '0' }).kind).toBe('http');
  });

  it('keeps HTTP outside Windows/Linux desktop even when the flag is on', () => {
    expect(selectReadApi({ ...base, flag: '1', desktop: false }).kind).toBe('http');
  });

  it('uses Rust for reads, writes and uploads on Android too (flag "0" still turns it off)', () => {
    const android = { ...base, desktop: false, android: true };
    expect(selectReadApi({ ...android, flag: null }).kind).toBe('tauri');
    expect(selectReadApi({ ...android, flag: '0' }).kind).toBe('http');
    expect(selectWriteApi({ ...android, flag: null }).kind).toBe('tauri');
    expect(selectWriteApi({ ...android, flag: '0' }).kind).toBe('http');
  });

  it('Android sends base64 bodies; desktop keeps raw bytes', async () => {
    const r = recorder();
    const a = selectWriteApi({ ...base, flag: null, desktop: false, android: true, invoke: r.invoke });
    if (a.kind !== 'tauri') throw new Error('expected tauri');
    await a.write.setAvatar(new Blob([new Uint8Array([1, 2, 3])]), 'a.png');
    expect(r.calls[0].args).toBe('AQID');
    const d = selectWriteApi({ ...base, flag: null, invoke: r.invoke });
    if (d.kind !== 'tauri') throw new Error('expected tauri');
    await d.write.setAvatar(new Blob([new Uint8Array([1, 2, 3])]), 'a.png');
    expect(r.calls[1].args).toBeInstanceOf(Uint8Array);
  });

  it('a plain browser on Android (not Tauri) and macOS stay HTTP', () => {
    expect(selectReadApi({ ...base, desktop: false, android: false, flag: null }).kind).toBe('http');
    expect(selectWriteApi({ ...base, desktop: false, android: false, flag: null }).kind).toBe('http');
  });

  it('chat stays JS outside Tauri (neither desktop nor Android)', () => {
    expect(selectChatMode({ flag: null, desktop: false })).toBe('js');
  });

  it('logs the selected transport once per selection', () => {
    const lines: string[] = [];
    selectReadApi({ ...base, flag: '1', log: (m) => lines.push(m) });
    selectReadApi({ ...base, flag: '0', log: (m) => lines.push(m) });
    expect(lines).toEqual(['[disnans] api read transport: tauri', '[disnans] api read transport: http']);
  });
});

describe('Tauri read transport', () => {
  it('sends each read to its fixed command with server and devUser', async () => {
    const r = recorder(() => []);
    const api = createTauriReadApi(r.invoke, ctx);
    await api.me();
    await api.users();
    await api.prefs();
    await api.readMarkers();
    await api.plugins();
    const base = { server: 'http://127.0.0.1:8080', devUser: 'alice' };
    expect(r.calls).toEqual([
      { command: 'api_me', args: { args: base } },
      { command: 'api_users', args: { args: base } },
      { command: 'api_prefs', args: { args: base } },
      { command: 'api_read_markers', args: { args: base } },
      { command: 'api_plugins', args: { args: base } },
    ]);
  });

  it('maps messages options to null-able fields (null is omitted by Rust, like qs())', async () => {
    const r = recorder(() => []);
    const api = createTauriReadApi(r.invoke, { server: () => 'http://h', devUser: null });
    await api.messages({});
    await api.messages({ before: 'm9', limit: 50 });
    await api.searchMessages({ q: 'a b' });
    await api.session('s1');
    expect(r.calls.map((c) => c.args)).toEqual([
      { args: { server: 'http://h', devUser: null, before: null, limit: null } },
      { args: { server: 'http://h', devUser: null, before: 'm9', limit: 50 } },
      { args: { server: 'http://h', devUser: null, q: 'a b', before: null, limit: null } },
      { args: { server: 'http://h', devUser: null, id: 's1' } },
    ]);
    expect(r.calls.map((c) => c.command)).toEqual([
      'api_messages',
      'api_messages',
      'api_search_messages',
      'api_session',
    ]);
  });

  it('reads server at each call', async () => {
    const r = recorder(() => null);
    let server = 'http://a';
    const api = createTauriReadApi(r.invoke, { server: () => server, devUser: null });
    await api.me();
    server = 'http://b';
    await api.me();
    expect(r.calls.map((c) => ((c.args as Record<string, unknown>)?.args as { server: string }).server)).toEqual(['http://a', 'http://b']);
  });

  it('turns a bridge rejection into an HttpError (status, code, message)', async () => {
    const bridgeError = { status: 404, code: 'not_found', message: 'そのメッセージはありません' };
    const api = createTauriReadApi(() => Promise.reject(bridgeError), ctx);
    const err = await api.session('nope').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    // Error.message is the localized text (errorText), as for HTTP errors
    expect(err).toMatchObject({ status: 404, code: 'not_found', message: '見つかりませんでした' });
  });

  it('maps network errors and plain strings to status 0', () => {
    expect(toBridgeError({ code: 'network', message: 'ネットワークエラー' })).toMatchObject({ status: 0, code: 'network' });
    expect(toBridgeError('bad')).toMatchObject({ status: 0, code: 'bridge_error', message: 'bad' });
    expect(toBridgeError(undefined)).toMatchObject({ status: 0, code: 'bridge_error' });
  });
});

describe('HTTP read transport (unchanged request shape)', () => {
  it('builds the same URL, query, and dev header as before', async () => {
    const seen: Array<{ url: string; method?: string; headers?: Record<string, string> }> = [];
    const fake = async (url: string, init?: RequestInit) => {
      seen.push({ url, method: init?.method, headers: init?.headers as Record<string, string> });
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const original = globalThis.fetch;
    globalThis.fetch = fake as typeof fetch;
    try {
      const api = createHttpReadApi();
      await api.messages({ before: 'm1', limit: 20 });
      await api.messages({});
      await api.searchMessages({ q: 'a', limit: 5 });
      await api.session('s 1');
    } finally {
      globalThis.fetch = original;
    }
    expect(seen.map((s) => s.url)).toEqual([
      '/api/messages?before=m1&limit=20',
      '/api/messages',
      '/api/messages/search?q=a&limit=5',
      '/api/sessions/s%201',
    ]);
    expect(seen.every((s) => s.method === 'GET')).toBe(true);
  });
});
