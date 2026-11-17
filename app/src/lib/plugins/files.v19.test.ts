// @vitest-environment jsdom
// API 19 の共有フォルダの口（files.url / upload / size / caps / ゴミ箱）。権限・パス・失敗の code を見る
import { describe, expect, it, vi } from 'vitest';
import { DISNANS_SHARED_CAPS, PluginFiles } from './files';
import { PluginError } from './errors';
import type { SharedApi } from '../transport/shared';
import type { SharedEntry } from '../protocol/SharedEntry';

const entry = (path: string): SharedEntry => ({
  name: path.split('/').pop()!,
  path,
  kind: 'file',
  size: 3,
  modified: 1,
  mime: null,
  message_id: null,
  file_id: null,
});

function fake(over: Partial<SharedApi> = {}): SharedApi {
  const noop = async () => {
    throw new Error('not used');
  };
  return {
    list: noop,
    read: noop,
    write: noop,
    mkdir: noop,
    remove: noop,
    move: noop,
    copy: noop,
    trash: vi.fn(async (path: string) => ({ id: 'T1', original_path: path, kind: 'file', size: 3, deleted_at: 1 })),
    trashList: vi.fn(async () => [{ id: 'T1', original_path: 'a.txt', kind: 'file', size: 3, deleted_at: 1 }]),
    restore: vi.fn(async (id: string) => entry(`back/${id}`)),
    purge: vi.fn(async () => {}),
    size: vi.fn(async () => ({ size: 9, files: 2, dirs: 1 })),
    upload: vi.fn(async (path: string) => entry(path)),
    ...over,
  } as SharedApi;
}

const noSub = () => () => {};

describe('files.url（同期・項目から）', () => {
  it('添付は ID の URL、縮小版は thumb。通常の項目はパスの URL', () => {
    const files = new PluginFiles(true, fake(), noSub);
    const att = { ...entry('attachments/a.png'), file_id: 'F1' };
    expect(files.url(att)).toMatch(/\/api\/files\/F1$/);
    expect(files.url(att, { thumb: true })).toMatch(/\/api\/files\/F1\/thumb$/);
    expect(files.url(entry('docs/a.png'))).toMatch(/\/api\/shared\/docs\/a\.png$/);
  });

  it('ゴミ箱の中の項目は、ID があってもパスの URL（消えた添付を読まない）', () => {
    const files = new PluginFiles(true, fake(), noSub);
    const t = { ...entry('.trash/x/a.png'), file_id: 'F1', trash: { kind: 'item', entry: { id: 'T', original_path: 'a', kind: 'file', size: 1, deleted_at: 1 } } } as never;
    expect(files.url(t)).toMatch(/\/api\/shared\/\.trash\/x\/a\.png$/);
  });

  it('権限が無ければ permission_denied、項目でなければ invalid_argument', () => {
    expect(() => new PluginFiles(false, fake(), noSub).url(entry('a'))).toThrow(expect.objectContaining({ code: 'permission_denied' }) as never);
    expect(() => new PluginFiles(true, fake(), noSub).url('a' as never)).toThrow(expect.objectContaining({ code: 'invalid_argument' }) as never);
  });
});

describe('files.upload', () => {
  it('送った量と全体（バイト）を通知する', async () => {
    const seen: [number, number][] = [];
    const api = fake({
      upload: vi.fn(async (_p: string, _f: Blob, onProgress?: (s: number, t: number) => void) => {
        onProgress?.(1, 4);
        onProgress?.(4, 4);
        return entry('x.txt');
      }),
    });
    const r = await new PluginFiles(true, api, noSub).upload('x.txt', new Blob(['abcd']), {
      onProgress: (s, t) => seen.push([s, t]),
    });
    expect(r.path).toBe('x.txt');
    expect(seen).toEqual([[1, 4], [4, 4]]);
  });

  it('既に中止されていれば送らず AbortError', async () => {
    const api = fake();
    const ac = new AbortController();
    ac.abort();
    await expect(new PluginFiles(true, api, noSub).upload('x', new Blob(['a']), { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(api.upload).not.toHaveBeenCalled();
  });

  it('送る途中で中止したら AbortError（サーバーの code ではなく）', async () => {
    const ac = new AbortController();
    const api = fake({
      upload: vi.fn(() => new Promise<SharedEntry>((_, reject) => ac.signal.addEventListener('abort', () => reject(new Error('aborted'))))),
    });
    const p = new PluginFiles(true, api, noSub).upload('x', new Blob(['a']), { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('Blob でないものは invalid_argument', async () => {
    await expect(new PluginFiles(true, fake(), noSub).upload('x', 'text' as unknown as Blob)).rejects.toMatchObject({ code: 'invalid_argument' });
  });
});

describe('files.size / caps / ゴミ箱', () => {
  it('size は本体の値をそのまま返す。パスを省くと全体', async () => {
    const api = fake();
    expect(await new PluginFiles(true, api, noSub).size()).toEqual({ size: 9, files: 2, dirs: 1 });
    expect(api.size).toHaveBeenCalledWith('');
  });

  it('caps は Disnans の置き場所（ゴミ箱あり・添付は attachments）', () => {
    expect(new PluginFiles(true, fake(), noSub).caps()).toEqual(DISNANS_SHARED_CAPS);
    expect(DISNANS_SHARED_CAPS).toEqual({ trash: true, restore: true, attachmentsDir: 'attachments' });
  });

  it('ゴミ箱の操作は本体へ渡す（一覧・入れる・戻す・完全に消す）', async () => {
    const api = fake();
    const files = new PluginFiles(true, api, noSub);
    expect((await files.trashList())[0].id).toBe('T1');
    expect((await files.trash('a.txt')).original_path).toBe('a.txt');
    expect((await files.restore('T1')).path).toBe('back/T1');
    await files.purge('T1');
    expect(api.purge).toHaveBeenCalledWith('T1');
  });

  it('ゴミ箱が無い置き場所では unsupported（操作は呼ばない）', async () => {
    const api = fake();
    const files = new PluginFiles(true, api, noSub, { trash: false, restore: false, attachmentsDir: null });
    await expect(files.trashList()).rejects.toMatchObject({ code: 'unsupported' });
    await expect(files.trash('a')).rejects.toBeInstanceOf(PluginError);
    await expect(files.restore('T1')).rejects.toMatchObject({ code: 'unsupported' });
    await expect(files.purge('T1')).rejects.toMatchObject({ code: 'unsupported' });
    expect(api.trash).not.toHaveBeenCalled();
    expect(api.purge).not.toHaveBeenCalled();
  });

  it('ゴミ箱はあるが戻せない置き場所では restore だけ unsupported（ほかは動く）', async () => {
    const api = fake();
    const files = new PluginFiles(true, api, noSub, { trash: true, restore: false, attachmentsDir: null });
    await expect(files.restore('T1')).rejects.toMatchObject({ code: 'unsupported' });
    expect(api.restore).not.toHaveBeenCalled();
    expect((await files.trashList()).length).toBe(1);
  });

  it('id が空なら invalid_argument、権限がなければ permission_denied', async () => {
    await expect(new PluginFiles(true, fake(), noSub).purge('')).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(new PluginFiles(false, fake(), noSub).size()).rejects.toMatchObject({ code: 'permission_denied' });
    expect(() => new PluginFiles(false, fake(), noSub).caps()).toThrow(PluginError);
  });
});
