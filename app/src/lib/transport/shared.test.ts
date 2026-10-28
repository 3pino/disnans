import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config', () => ({
  apiUrl: (p: string) => `https://srv${p}`,
  authHeaders: () => ({ Authorization: 'Bearer t' }),
}));

const { sharedApi, sharedUrl, sharedSizePath } = await import('./shared');
const { sharedPath } = await import('../sharedPath');
const { HttpError } = await import('./http');

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
let reply: (call: Call) => Response;

beforeEach(() => {
  calls = [];
  reply = () => new Response(JSON.stringify({ path: '', entries: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const call = { url, init };
    calls.push(call);
    return reply(call);
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('パスを URL にする', () => {
  it('区切りごとに URL の形にする（空は /api/shared そのもの）', () => {
    expect(sharedPath('')).toBe('/api/shared');
    expect(sharedPath('docs/a b.txt')).toBe('/api/shared/docs/a%20b.txt');
    expect(sharedPath('日本/メモ?.txt')).toBe(`/api/shared/${encodeURIComponent('日本')}/${encodeURIComponent('メモ?.txt')}`);
    expect(sharedUrl('x')).toBe('https://srv/api/shared/x');
  });
});

describe('sharedApi（HTTP）', () => {
  it('list はフォルダの中身（entries）を返す。直下は /api/shared', async () => {
    reply = () => new Response(JSON.stringify({ path: '', entries: [{ name: 'a', path: 'a', kind: 'file', size: 1, modified: 2, mime: null, message_id: null }] }), { status: 200 });
    const list = await sharedApi.list('');
    expect(list).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://srv/api/shared');
    expect(calls[0]!.init.method).toBe('GET');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer t');
  });

  it('read は中身を Blob で返す', async () => {
    reply = () => new Response('hello', { status: 200 });
    const blob = await sharedApi.read('docs/a.txt');
    expect(await blob.text()).toBe('hello');
    expect(calls[0]!.url).toBe('https://srv/api/shared/docs/a.txt');
  });

  it('write は PUT で本文をそのまま送り、SharedEntry を返す', async () => {
    const body = new Blob(['x']);
    reply = () => new Response(JSON.stringify({ name: 'a', path: 'a', kind: 'file', size: 1, modified: 0, mime: null, message_id: null }), { status: 200 });
    const e = await sharedApi.write('a', body);
    expect(e.path).toBe('a');
    expect(calls[0]!.init.method).toBe('PUT');
    expect(calls[0]!.init.body).toBe(body);
  });

  it('mkdir・move・copy は POST /api/shared に op を送る', async () => {
    reply = () => new Response(JSON.stringify({ name: 'd', path: 'd', kind: 'dir', size: 0, modified: 0, mime: null, message_id: null }), { status: 200 });
    await sharedApi.mkdir('d');
    await sharedApi.move('a', 'd/a');
    await sharedApi.copy('d/a', 'b');
    expect(calls.map((c) => c.init.method)).toEqual(['POST', 'POST', 'POST']);
    expect(calls.map((c) => JSON.parse(c.init.body as string))).toEqual([
      { op: 'mkdir', path: 'd' },
      { op: 'move', from: 'a', to: 'd/a' },
      { op: 'copy', from: 'd/a', to: 'b' },
    ]);
    expect(calls[0]!.url).toBe('https://srv/api/shared');
  });

  it('move・copy は overwrite を真のときだけ送る（省略は送らない）', async () => {
    reply = () => new Response(JSON.stringify({ name: 'x', path: 'x', kind: 'file', size: 0, modified: 0, mime: null, message_id: null }), { status: 200 });
    await sharedApi.move('a', 'b');
    await sharedApi.move('a', 'b', false);
    await sharedApi.copy('a', 'b', true);
    expect(calls.map((c) => JSON.parse(c.init.body as string))).toEqual([
      { op: 'move', from: 'a', to: 'b' },
      { op: 'move', from: 'a', to: 'b' },
      { op: 'copy', from: 'a', to: 'b', overwrite: true },
    ]);
  });

  it('remove は DELETE（204）', async () => {
    reply = () => new Response(null, { status: 204 });
    await sharedApi.remove('docs/a b.txt');
    expect(calls[0]!.init.method).toBe('DELETE');
    expect(calls[0]!.url).toBe('https://srv/api/shared/docs/a%20b.txt');
  });

  it('失敗はサーバーの code の HttpError', async () => {
    reply = () => new Response(JSON.stringify({ code: 'parent_missing', message: '親がない' }), { status: 409 });
    const err = await sharedApi.write('x/y', 'z').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as InstanceType<typeof HttpError>).code).toBe('parent_missing');
    expect((err as InstanceType<typeof HttpError>).status).toBe(409);
  });
});

describe('sharedApi（ゴミ箱・大きさ）', () => {
  const trashed = { id: '01HZX0000000000000000000AB', original_path: 'docs/a.txt', kind: 'file', size: 3, deleted_at: 9 };

  it('trash は POST /api/shared-trash に {op:"trash",path} を送り、入った項目を返す', async () => {
    reply = () => new Response(JSON.stringify(trashed), { status: 200 });
    const e = await sharedApi.trash('docs/a.txt');
    expect(e.id).toBe(trashed.id);
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.url).toBe('https://srv/api/shared-trash');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ op: 'trash', path: 'docs/a.txt' });
  });

  it('添付も同じ口で入れられる（パスは attachments/<file_id> の形のまま送る）', async () => {
    reply = () => new Response(JSON.stringify({ ...trashed, original_path: 'attachments/F1' }), { status: 200 });
    await sharedApi.trash('attachments/F1');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ op: 'trash', path: 'attachments/F1' });
  });

  it('trashList は GET /api/shared-trash の entries を返す（読取の時間の打ち切りあり）', async () => {
    reply = () => new Response(JSON.stringify({ entries: [trashed] }), { status: 200 });
    expect(await sharedApi.trashList()).toEqual([trashed]);
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.url).toBe('https://srv/api/shared-trash');
  });

  it('restore は {op:"restore",id}。戻った項目を返す。同名は 409 exists（上書きしない）', async () => {
    reply = () => new Response(JSON.stringify({ name: 'a.txt', path: 'docs/a.txt', kind: 'file', size: 3, modified: 0, mime: null, message_id: null }), { status: 200 });
    const e = await sharedApi.restore(trashed.id);
    expect(e.path).toBe('docs/a.txt');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ op: 'restore', id: trashed.id });
    reply = () => new Response(JSON.stringify({ code: 'exists', message: '同じ名前があります' }), { status: 409 });
    const err = await sharedApi.restore(trashed.id).catch((x: unknown) => x);
    expect((err as InstanceType<typeof HttpError>).code).toBe('exists');
  });

  it('restore の親が無いときは 409 parent_missing', async () => {
    reply = () => new Response(JSON.stringify({ code: 'parent_missing', message: '親がない' }), { status: 409 });
    const err = await sharedApi.restore(trashed.id).catch((x: unknown) => x);
    expect((err as InstanceType<typeof HttpError>).code).toBe('parent_missing');
  });

  it('purge は DELETE /api/shared-trash/{id}（ID は URL にする）', async () => {
    reply = () => new Response(null, { status: 204 });
    await sharedApi.purge('A/B');
    expect(calls[0]!.init.method).toBe('DELETE');
    expect(calls[0]!.url).toBe('https://srv/api/shared-trash/A%2FB');
  });

  it('size は GET /api/shared-size/{path}。ルートは /api/shared-size（添付を含む大きさ）', async () => {
    reply = () => new Response(JSON.stringify({ size: 10, files: 2, dirs: 1 }), { status: 200 });
    expect(await sharedApi.size('docs')).toEqual({ size: 10, files: 2, dirs: 1 });
    expect(calls[0]!.url).toBe('https://srv/api/shared-size/docs');
    await sharedApi.size('');
    expect(calls[1]!.url).toBe('https://srv/api/shared-size');
    expect(calls[1]!.init.method).toBe('GET');
  });

  it('sharedSizePath は区切りごとに URL の形にする', () => {
    expect(sharedSizePath('')).toBe('/api/shared-size');
    expect(sharedSizePath('docs/a b')).toBe('/api/shared-size/docs/a%20b');
  });

  it('既存の remove は永久削除（DELETE /api/shared/…）のまま。ゴミ箱は通らない', async () => {
    reply = () => new Response(null, { status: 204 });
    await sharedApi.remove('x.txt');
    expect(calls[0]!.url).toBe('https://srv/api/shared/x.txt');
  });
});
