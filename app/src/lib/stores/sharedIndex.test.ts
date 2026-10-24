import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SharedEntry } from '../protocol/SharedEntry';
import { HttpError } from '../transport/http';

const list = vi.fn<(path: string) => Promise<SharedEntry[]>>();
vi.mock('../transport/shared', () => ({ sharedApi: { list: (p: string) => list(p) } }));

const { SharedIndex, affects } = await import('./sharedIndex.svelte');

const entry = (path: string, over: Partial<SharedEntry> = {}): SharedEntry => ({
  name: path.split('/').pop()!,
  path,
  kind: 'file',
  size: 1,
  modified: 0,
  mime: null,
  message_id: null,
  file_id: null,
  ...over,
});

/** 次の tick まで待つ（読み込みの結果が手元に入るまで） */
const settle = () => new Promise((r) => setTimeout(r, 0));

let idx: InstanceType<typeof SharedIndex>;
beforeEach(() => {
  list.mockReset();
  idx = new SharedIndex();
});

describe('affects（どのフォルダの一覧が変わるか）', () => {
  it('項目の親・項目そのもの・中身が対象', () => {
    expect(affects('attachments', 'attachments/a.png')).toBe(true);
    expect(affects('', 'attachments/a.png')).toBe(false);
    expect(affects('docs', 'docs')).toBe(true);
    expect(affects('docs/sub', 'docs')).toBe(true);
    expect(affects('docsx', 'docs')).toBe(false);
    expect(affects('other', 'docs/a')).toBe(false);
  });
});

describe('SharedIndex', () => {
  it('ensure で読み、file() は見つかった項目を返す。読み込み中は loading', async () => {
    list.mockResolvedValue([entry('attachments/a.png', { file_id: 'F1' })]);
    expect(idx.file('attachments/a.png')).toEqual({ kind: 'loading' });
    idx.ensure('attachments');
    expect(idx.file('attachments/a.png')).toEqual({ kind: 'loading' });
    await settle();
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith('attachments');
    const st = idx.file('attachments/a.png');
    expect(st.kind).toBe('found');
    expect(st.kind === 'found' && st.entry.file_id).toBe('F1');
  });

  it('同じフォルダは一度だけ読む（ensure を重ねても）', async () => {
    list.mockResolvedValue([]);
    idx.ensure('docs');
    idx.ensure('docs');
    await settle();
    idx.ensure('docs');
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('一覧にない名前は missing。大文字・小文字の違いは同じものとみなす', async () => {
    list.mockResolvedValue([entry('attachments/Photo.PNG')]);
    idx.ensure('attachments');
    await settle();
    expect(idx.file('attachments/photo.png').kind).toBe('found');
    expect(idx.file('attachments/none.png')).toEqual({ kind: 'missing' });
  });

  it('フォルダが 404 なら missing（その中の項目も missing）', async () => {
    list.mockRejectedValue(new HttpError(404, 'not_found', 'x'));
    idx.ensure('nope');
    await settle();
    expect(idx.state('nope')).toEqual({ kind: 'missing' });
    expect(idx.file('nope/a.txt')).toEqual({ kind: 'missing' });
  });

  it('それ以外の失敗は error。次に ensure されるまで読み直さない（invalidate で読み直す）', async () => {
    list.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    idx.ensure('docs');
    await settle();
    expect(idx.state('docs')?.kind).toBe('error');
    idx.ensure('docs');
    expect(list).toHaveBeenCalledTimes(1);
    list.mockResolvedValueOnce([entry('docs/a.txt')]);
    idx.invalidate('docs/a.txt');
    expect(idx.state('docs')).toBeUndefined();
    idx.ensure('docs');
    await settle();
    expect(idx.file('docs/a.txt').kind).toBe('found');
  });

  it('invalidate は親の一覧を捨てる（読み直しは ensure で）。ほかのフォルダは残す', async () => {
    list.mockResolvedValue([entry('docs/a.txt')]);
    idx.ensure('docs');
    idx.ensure('attachments');
    await settle();
    idx.invalidate('docs/b.txt');
    expect(idx.state('docs')).toBeUndefined();
    expect(idx.state('attachments')?.kind).toBe('ok');
  });

  it('読み込みの途中で変わったら、古い結果は使わない', async () => {
    let resolveOld!: (v: SharedEntry[]) => void;
    list.mockReturnValueOnce(new Promise<SharedEntry[]>((r) => (resolveOld = r)));
    idx.ensure('attachments');
    idx.invalidate('attachments/x.png');
    list.mockResolvedValueOnce([entry('attachments/new.png')]);
    idx.ensure('attachments');
    resolveOld([entry('attachments/old.png')]);
    await settle();
    expect(idx.file('attachments/old.png')).toEqual({ kind: 'missing' });
    expect(idx.file('attachments/new.png').kind).toBe('found');
  });
});

describe('clear（接続先の切り替え）', () => {
  it('写しを捨て、読んでいる途中の旧サーバーの結果も捨てる', async () => {
    let resolve!: (v: SharedEntry[]) => void;
    list.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    idx.ensure('docs');
    idx.clear();
    expect(idx.state('docs')).toBeUndefined();
    resolve([entry('docs/old.txt')]);
    await settle();
    expect(idx.state('docs')).toBeUndefined();
  });

  it('捨てたあとは新しく読む', async () => {
    list.mockResolvedValue([entry('a.txt')]);
    idx.ensure('');
    await settle();
    idx.clear();
    expect(idx.state('')).toBeUndefined();
    idx.ensure('');
    await settle();
    expect(idx.state('')?.kind).toBe('ok');
  });
});

describe('投稿前の自分の添付（送信の途中の本文のリンク）', () => {
  it('一覧にまだ無い投稿前の添付は、見つからないではなく読み込み中', async () => {
    list.mockResolvedValue([entry('attachments/old.png')]);
    idx.ensure('attachments');
    await settle();
    expect(idx.file('attachments/new.png').kind).toBe('missing');
    idx.setUnposted('attachments/new.png', true);
    expect(idx.file('attachments/new.png').kind).toBe('loading');
    // 大文字・小文字の違いは同じもの
    expect(idx.file('attachments/NEW.png').kind).toBe('loading');
  });

  it('一覧に現れたら（投稿された）、印は自動で外れる', async () => {
    list.mockResolvedValueOnce([entry('attachments/old.png')]);
    idx.ensure('attachments');
    await settle();
    idx.setUnposted('attachments/new.png', true);
    idx.invalidate('attachments/new.png');
    list.mockResolvedValueOnce([entry('attachments/old.png'), entry('attachments/new.png')]);
    idx.ensure('attachments');
    await settle();
    expect(idx.file('attachments/new.png').kind).toBe('found');
    // 一度外れたあとで、同じ名前が消えても、読み込み中にはならない
    list.mockResolvedValueOnce([entry('attachments/old.png')]);
    idx.invalidate('attachments/new.png');
    idx.ensure('attachments');
    await settle();
    expect(idx.file('attachments/new.png').kind).toBe('missing');
  });

  it('取り消したら印を外す（そのあとは見つからない）', async () => {
    list.mockResolvedValue([]);
    idx.ensure('attachments');
    await settle();
    idx.setUnposted('attachments/a.png', true);
    expect(idx.file('attachments/a.png').kind).toBe('loading');
    idx.setUnposted('attachments/a.png', false);
    expect(idx.file('attachments/a.png').kind).toBe('missing');
  });
});
