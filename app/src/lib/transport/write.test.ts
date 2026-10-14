import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpWriteApi, createTauriWriteApi, NON_IDEMPOTENT, UNKNOWN_OUTCOME, writeError } from './write';
import { HttpError } from './http';
import type { Invoke } from './types';

type Call = { command: string; args?: Record<string, unknown> | Uint8Array | string; options?: { headers?: Record<string, string> } };

function recorder(reply: (command: string) => unknown = () => null) {
  const calls: Call[] = [];
  const invoke: Invoke = async <T>(command: string, args?: Record<string, unknown> | Uint8Array | string, options?: { headers?: Record<string, string> }) => {
    calls.push({ command, args, options });
    const r = reply(command);
    if (r instanceof Error || (r && typeof r === 'object' && 'reject' in r)) throw (r as { reject: unknown }).reject ?? r;
    return r as T;
  };
  return { calls, invoke };
}

const ctx = { server: () => 'http://127.0.0.1:8080', devUser: 'alice' as string | null };

describe('Tauri write API: commands and arguments', () => {
  it('JSON writes send {server, devUser, ...} in args to the fixed command names', async () => {
    const r = recorder();
    const api = createTauriWriteApi(r.invoke, ctx);
    await api.updateMe({ display_name: 'A' } as never);
    await api.setPrefs({ theme: 'dark' });
    await api.updateThread('t1', { title: 'x', archived: false } as never);
    await api.setThreadTags('t1', [{ icon: 'a', label: 'b' }] as never);
    await api.clearAvatar();
    await api.markRead({ thread_id: null, message_id: 'm1' } as never);
    await api.deletePlugin('p1');
    expect(r.calls.map((c) => c.command)).toEqual([
      'api_update_me', 'api_set_prefs', 'api_update_thread', 'api_set_thread_tags', 'api_clear_avatar', 'api_mark_read', 'api_delete_plugin',
    ]);
    for (const c of r.calls) {
      expect(c.args).toMatchObject({ args: { server: 'http://127.0.0.1:8080', devUser: 'alice' } });
    }
    expect(r.calls[2].args).toMatchObject({ args: { id: 't1' } });
    expect(r.calls[6].args).toMatchObject({ args: { id: 'p1' } });
  });

  it('avatar and create-plugin send raw bytes; args go in one x-disnans-args header', async () => {
    const r = recorder();
    const api = createTauriWriteApi(r.invoke, { server: () => 'http://h:1', devUser: null });
    await api.setAvatar(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'てすと.png');
    const avatar = r.calls[0];
    expect(avatar.command).toBe('api_set_avatar');
    expect(Array.from(avatar.args as Uint8Array)).toEqual([1, 2, 3]);
    expect(Object.keys(avatar.options?.headers ?? {})).toEqual(['x-disnans-args']);
    expect(JSON.parse(decodeURIComponent(avatar.options!.headers!['x-disnans-args']))).toEqual({
      server: 'http://h:1',
      devUser: null,
      fileName: 'てすと.png',
      mime: 'image/png',
    });

    await api.publishPlugin(
      [
        { name: 'manifest.json', data: new Blob([new Uint8Array([9])]) },
        { name: 'main.js', data: new Blob([new Uint8Array([7, 8])]) },
      ],
      'private',
    );
    const pub = r.calls[1];
    expect(pub.command).toBe('api_create_plugin');
    expect(Array.from(pub.args as Uint8Array)).toEqual([9, 7, 8]);
    expect(JSON.parse(decodeURIComponent(pub.options!.headers!['x-disnans-args']))).toMatchObject({
      visibility: 'private',
      parts: [
        { name: 'manifest.json', size: 1 },
        { name: 'main.js', size: 2 },
      ],
    });
  });

  it('an empty MIME type is sent as null', async () => {
    const r = recorder();
    const api = createTauriWriteApi(r.invoke, ctx);
    await api.setAvatar(new Blob([new Uint8Array([1])]), 'a');
    expect(JSON.parse(decodeURIComponent(r.calls[0].options!.headers!['x-disnans-args'])).mime).toBeNull();
  });
});

describe('Tauri write API: outcome of failures', () => {
  it('a status-less failure of a non-idempotent write is unknown_outcome (never success, never a resend)', async () => {
    for (const name of NON_IDEMPOTENT) {
      const r = recorder(() => new Error('command not found'));
      const api = createTauriWriteApi(r.invoke, ctx);
      const call = {
        sampleNotification: () => api.sampleNotification(),
        publishPlugin: () => api.publishPlugin([], 'public'),
        pluginPostMessage: () => api.pluginPostMessage('p', {} as never),
        pluginNotify: () => api.pluginNotify('p', {} as never),
        createSession: () => api.createSession({} as never),
      }[name]!;
      const err = await call().then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).code).toBe(UNKNOWN_OUTCOME);
      expect(r.calls).toHaveLength(1);
    }
  });

  it('before-send codes (network, timeout, invalid_request) are not unknown_outcome, even when non-idempotent', async () => {
    for (const code of ['network', 'timeout', 'invalid_request']) {
      const r = recorder(() => ({ reject: { code, message: 'm' } }));
      const api = createTauriWriteApi(r.invoke, ctx);
      const err = (await api.createSession({} as never).then(() => null, (e: unknown) => e)) as HttpError;
      expect(err.code).toBe(code);
    }
  });

  it('a status-less failure of an idempotent write keeps its bridge code (retry is the user\'s choice)', async () => {
    const r = recorder(() => new Error('boom'));
    const api = createTauriWriteApi(r.invoke, ctx);
    const err = (await api.updateMe({} as never).then(() => null, (e: unknown) => e)) as HttpError;
    expect(err.code).toBe('bridge_error');
    expect(r.calls).toHaveLength(1);
  });

  it('an HTTP status from Rust is kept as-is, even for a non-idempotent write', async () => {
    const r = recorder(() => ({ reject: { status: 404, code: 'not_found', message: 'no' } }));
    const api = createTauriWriteApi(r.invoke, ctx);
    const err = (await api.pluginPostMessage('p', {} as never).then(() => null, (e: unknown) => e)) as HttpError;
    expect(err.code).toBe('not_found');
    expect(err.status).toBe(404);
  });

  it('writeError keeps the success path untouched', () => {
    expect(writeError({ status: 500, code: 'internal', message: 'x' }, true)).toMatchObject({ code: 'internal', status: 500 });
  });
});

describe('HTTP write API (existing behaviour)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the same method and path as before', async () => {
    const urls: string[] = [];
    const methods: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      urls.push(url);
      methods.push(init?.method ?? 'GET');
      return new Response(JSON.stringify({ id: 'x' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const api = createHttpWriteApi();
    await api.clearAvatar();
    await api.createSession({} as never);
    await api.updateSession('s/1', {} as never);
    expect(methods).toEqual(['DELETE', 'POST', 'PUT']);
    expect(urls[2]).toMatch(/\/api\/sessions\/s%2F1$/);
  });
});

describe('Tauri write API on Android (base64 body)', () => {
  it('avatar and plugin bodies are base64 strings; JSON writes are unchanged', async () => {
    const r = recorder();
    const api = createTauriWriteApi(r.invoke, ctx, 'base64');
    await api.setAvatar(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'a.png');
    expect(r.calls[0].command).toBe('api_set_avatar');
    expect(r.calls[0].args).toBe('AQID');
    await api.publishPlugin([{ name: 'a.js', data: new Blob([new Uint8Array([9])]) } as never], 'public');
    expect(r.calls[1].args).toBe('CQ==');
    await api.clearAvatar();
    expect(r.calls[2].args).toEqual({ args: expect.objectContaining({ server: ctx.server() }) });
  });
});
