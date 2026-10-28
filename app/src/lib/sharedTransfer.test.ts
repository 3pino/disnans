import { describe, expect, it, vi } from 'vitest';
import { checkTransfer, planTransfer, runTransfer, transferFailure, type TransferItem } from './sharedTransfer';
import type { SharedEntry } from './protocol/SharedEntry';

const f = (path: string): TransferItem => ({ path, kind: 'file' });
const d = (path: string): TransferItem => ({ path, kind: 'dir' });
const entry = (path: string, kind: 'file' | 'dir' = 'file'): SharedEntry => ({
  name: path.split('/').pop()!,
  path,
  kind,
  size: 1,
  modified: 0,
  mime: null,
  message_id: null,
  file_id: null,
});
const entries = (...list: SharedEntry[]) => new Map(list.map((e) => [e.name, e]));

describe('checkTransfer（サーバーの決まりと同じ）', () => {
  it('共有フォルダの中の移動・コピーはできる（フォルダの移動も）', () => {
    expect(checkTransfer('move', d('docs'), 'other').ok).toBe(true);
    expect(checkTransfer('move', f('a.txt'), 'docs').ok).toBe(true);
    expect(checkTransfer('copy', f('a.txt'), 'docs').ok).toBe(true);
  });
  it('共有フォルダと attachments/ の間は移動できない（コピーは可）', () => {
    expect(checkTransfer('move', f('a.txt'), 'attachments')).toMatchObject({ ok: false });
    expect(checkTransfer('move', f('attachments/x.png'), 'docs')).toMatchObject({ ok: false });
    expect(checkTransfer('copy', f('a.txt'), 'attachments').ok).toBe(true);
    expect(checkTransfer('copy', f('attachments/x.png'), 'docs').ok).toBe(true);
  });
  it('フォルダをコピーできる（他の場所へ）', () => {
    expect(checkTransfer('copy', d('docs'), 'other').ok).toBe(true);
    expect(checkTransfer('copy', d('docs'), '').ok).toBe(true);
    expect(checkTransfer('copy', d('docs/sub'), 'other').ok).toBe(true);
  });
  it('フォルダを自分の中へ移せない', () => {
    expect(checkTransfer('move', d('docs'), 'docs')).toMatchObject({ ok: false });
    expect(checkTransfer('move', d('docs'), 'docs/sub')).toMatchObject({ ok: false });
    expect(checkTransfer('move', d('docs'), 'docsx').ok).toBe(true);
  });
  it('フォルダを自分の中へコピーできない', () => {
    expect(checkTransfer('copy', d('docs'), 'docs')).toMatchObject({ ok: false });
    expect(checkTransfer('copy', d('docs'), 'docs/sub')).toMatchObject({ ok: false });
    expect(checkTransfer('copy', d('docs'), 'docsx').ok).toBe(true);
  });
  it('attachments/ そのものは動かせない', () => {
    expect(checkTransfer('move', d('attachments'), 'docs')).toMatchObject({ ok: false });
  });
});

describe('planTransfer', () => {
  it('同名が無ければ作る、あれば上書き（確認が要る）', () => {
    const plan = planTransfer('copy', [f('x/a.txt'), f('x/b.txt')], 'y', entries(entry('y/b.txt')));
    expect(plan.map((p) => p.kind)).toEqual(['create', 'overwrite']);
    expect(plan[1].to).toBe('y/b.txt');
  });
  it('同じ場所への移動・コピーは何もしない（skip）', () => {
    const plan = planTransfer('move', [f('docs/a.txt')], 'docs', entries(entry('docs/a.txt')));
    expect(plan[0].kind).toBe('skip');
    expect(planTransfer('copy', [f('a.txt')], '', entries(entry('a.txt')))[0].kind).toBe('skip');
  });
  it('同名のフォルダがあれば止める', () => {
    const plan = planTransfer('copy', [f('a.txt')], 'y', entries(entry('y/a.txt', 'dir')));
    expect(plan[0]).toMatchObject({ kind: 'blocked', message: '同じ名前のフォルダがあります' });
  });
  it('移動先の一覧が無ければ止める（同名を黙って上書きしない）', () => {
    expect(planTransfer('copy', [f('a.txt')], 'y', null)[0]).toMatchObject({ kind: 'blocked' });
  });
  it('attachments/ への名前は、添付の決まりで見る（[ ] | は止める）', () => {
    expect(planTransfer('copy', [f('docs/a[1].png')], 'attachments', entries())[0]).toMatchObject({ kind: 'blocked' });
    expect(planTransfer('copy', [f('docs/a (1).png')], 'attachments', entries())[0].kind).toBe('create');
  });
  it('attachments/ の中では大文字・小文字の違う同名を上書きとして扱い、先は既存の名前に合わせる', () => {
    const plan = planTransfer('copy', [f('docs/A.png')], 'attachments', entries(entry('attachments/a.png')));
    expect(plan[0]).toMatchObject({ kind: 'overwrite', to: 'attachments/a.png' });
  });
  it('同じ項目の場所（attachments/ の中）は、何もしない（上書きにしない）', () => {
    const plan = planTransfer('move', [f('attachments/a.png')], 'attachments', entries(entry('attachments/a.png')));
    expect(plan[0].kind).toBe('skip');
  });
});

describe('runTransfer', () => {
  const api = () => ({
    move: vi.fn(async (_from: string, _to: string, _overwrite?: boolean) => entry('')),
    copy: vi.fn(async (_from: string, _to: string, _overwrite?: boolean) => entry('')),
  });

  it('コピーは、できたものを done に入れ、ほかを残す。上書きは確認してから、overwrite を真で送る', async () => {
    const a = api();
    const invalidate = vi.fn();
    const confirm = vi.fn(async () => true);
    const r = await runTransfer({
      op: 'copy',
      items: [f('x/a.txt'), f('x/b.txt')],
      destDir: 'y',
      destEntries: entries(entry('y/b.txt')),
      confirm,
      api: a,
      invalidate,
    });
    expect(a.copy).toHaveBeenNthCalledWith(1, 'x/a.txt', 'y/a.txt', false);
    expect(a.copy).toHaveBeenNthCalledWith(2, 'x/b.txt', 'y/b.txt', true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(r.done).toHaveLength(2);
    expect(invalidate).toHaveBeenCalledWith('x/a.txt');
    expect(invalidate).toHaveBeenCalledWith('y/a.txt');
  });

  it('上書きを取り消したら、送らず skipped に入れる', async () => {
    const a = api();
    const r = await runTransfer({
      op: 'move',
      items: [f('x/b.txt')],
      destDir: 'y',
      destEntries: entries(entry('y/b.txt')),
      confirm: async () => false,
      api: a,
      invalidate: () => {},
    });
    expect(a.move).not.toHaveBeenCalled();
    expect(r.declined).toHaveLength(1);
    expect(r.skipped).toHaveLength(0);
  });

  it('失敗しても残りは続け、失敗を failed に入れる', async () => {
    const a = api();
    a.copy.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'forbidden' }));
    const r = await runTransfer({
      op: 'copy',
      items: [f('x/a.txt'), f('x/b.txt')],
      destDir: 'y',
      destEntries: entries(),
      confirm: async () => true,
      api: a,
      invalidate: () => {},
    });
    expect(r.failed.map((x) => x.item.path)).toEqual(['x/a.txt']);
    expect(r.done.map((x) => x.path)).toEqual(['x/b.txt']);
    expect(transferFailure(r)).toContain('a.txt');
  });

  it('決まりに合わない項目（添付との間の移動）は送らず failed に入れる', async () => {
    const a = api();
    const r = await runTransfer({
      op: 'move',
      items: [f('docs/a.txt')],
      destDir: 'attachments',
      destEntries: entries(),
      confirm: async () => true,
      api: a,
      invalidate: () => {},
    });
    expect(a.move).not.toHaveBeenCalled();
    expect(r.failed[0].message).toContain('コピーしてください');
  });

  it('失敗がなければ transferFailure は null', async () => {
    expect(transferFailure({ done: [], failed: [], skipped: [], declined: [] })).toBeNull();
  });
});
