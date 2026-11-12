import { describe, expect, it } from 'vitest';
import { HttpError } from './httpError';
import { createTauriReadApi, toBridgeError } from './tauri';
import { selectReadApi, selectWriteApi } from './select';
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

describe('transport selection (Rust only)', () => {
  const base = { bodyMode: 'raw' as const, invoke: recorder().invoke, context: ctx };

  it('reads are the Tauri API', async () => {
    const r = recorder(() => ({ id: 'u1' }));
    expect(await selectReadApi({ ...base, invoke: r.invoke }).me()).toEqual({ id: 'u1' });
    expect(r.calls[0].command).toBe('api_me');
  });

  it('Android sends base64 bodies; desktop keeps raw bytes', async () => {
    const r = recorder();
    const a = selectWriteApi({ ...base, bodyMode: 'base64', invoke: r.invoke });
    await a.write.setAvatar(new Blob([new Uint8Array([1, 2, 3])]), 'a.png');
    expect(r.calls[0].args).toBe('AQID');
    const d = selectWriteApi({ ...base, invoke: r.invoke });
    await d.write.setAvatar(new Blob([new Uint8Array([1, 2, 3])]), 'a.png');
    expect(r.calls[1].args).toBeInstanceOf(Uint8Array);
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

