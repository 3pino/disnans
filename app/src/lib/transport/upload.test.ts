import { describe, expect, it, vi } from 'vitest';
import { createTauriUploadApi, type UploadItem } from './upload';
import { HttpError } from './http';
import type { Invoke } from './types';

type Call = { command: string; args?: unknown; options?: { headers?: Record<string, string> } };

function setup(reply: (command: string) => unknown = () => ({ id: 'a1' })) {
  const calls: Call[] = [];
  const invoke: Invoke = async <T>(command: string, args?: unknown, options?: { headers?: Record<string, string> }) => {
    calls.push({ command, args, options });
    const r = reply(command);
    if (r instanceof Error) throw r;
    return r as T;
  };
  let channel: { onmessage: (i: UploadItem) => void; toJSON: () => string } | null = null;
  const make = async () => {
    channel = { onmessage: () => {}, toJSON: () => '__CHANNEL__:7' };
    return channel;
  };
  const api = createTauriUploadApi(invoke, { server: () => 'http://h:1', devUser: 'bob' }, make);
  return { calls, api, ch: () => channel! };
}

describe('Tauri upload', () => {
  it('sends the bytes raw; args (incl. uploadId and the progress channel) go in x-disnans-args', async () => {
    const { calls, api } = setup();
    const file = new File([new Uint8Array([1, 2])], 'とても長い名前.png', { type: 'image/png' });
    const h = api.upload(file);
    await expect(h.promise).resolves.toEqual({ id: 'a1' });
    const c = calls[0];
    expect(c.command).toBe('api_upload_file');
    expect(Array.from(c.args as Uint8Array)).toEqual([1, 2]);
    expect(Object.keys(c.options?.headers ?? {})).toEqual(['x-disnans-args']);
    const args = JSON.parse(decodeURIComponent(c.options!.headers!['x-disnans-args']));
    expect(args).toMatchObject({
      server: 'http://h:1',
      devUser: 'bob',
      fileName: 'とても長い名前.png',
      mime: 'image/png',
      onProgress: '__CHANNEL__:7',
    });
    expect(args.uploadId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reports progress from the channel as a ratio', async () => {
    const { api, ch } = setup(() => new Promise(() => {}));
    const ratios: number[] = [];
    api.upload(new File([new Uint8Array(4)], 'a.bin'), (r) => ratios.push(r));
    await vi.waitFor(() => expect(ch()).toBeTruthy());
    ch().onmessage({ kind: 'progress', loaded: 1, total: 4 });
    ch().onmessage({ kind: 'progress', loaded: 4, total: 4 });
    ch().onmessage({ kind: 'progress', loaded: 0, total: 0 });
    expect(ratios).toEqual([0.25, 1]);
  });

  it('a Rust error becomes an HttpError; no automatic retry', async () => {
    const { calls, api } = setup(() => new Error('ipc broke'));
    const err = (await api.upload(new File([], 'a')).promise.then(() => null, (e: unknown) => e)) as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect(calls).toHaveLength(1);
  });

  it('abort rejects at once with aborted and asks Rust to stop the upload', async () => {
    const { calls, api } = setup(() => new Promise(() => {}));
    const h = api.upload(new File([new Uint8Array(1)], 'a'));
    await vi.waitFor(() => expect(calls.length).toBe(1));
    h.abort();
    const err = (await h.promise.then(() => null, (e: unknown) => e)) as HttpError;
    expect(err.code).toBe('aborted');
    const abort = calls.find((c) => c.command === 'api_upload_abort');
    const uploadId = JSON.parse(decodeURIComponent(calls[0].options!.headers!['x-disnans-args'])).uploadId;
    expect(abort?.args).toEqual({ uploadId });
  });
});
