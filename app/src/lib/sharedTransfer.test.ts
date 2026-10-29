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

describe('ゴミ箱の項目（仮想フォルダ）の移動・コピー', () => {
  const ENTRY = (name: string, path: string): SharedEntry => ({ name, path, kind: 'file', size: 1, modified: 0, mime: null, message_id: null, file_id: null });
  const item = (path: string, restoreTo: string, name = restoreTo.split('/').pop()): TransferItem => ({
    path,
    kind: 'file',
    name,
    trash: { where: 'item', restoreTo },
  });
  const ALIAS = '.trash/01HZX0000000000000000000AB--report.pdf';

  it('直下の項目は、元の名前でコピーする（別名のままにしない）', () => {
    const plan = planTransfer('copy', [item(ALIAS, 'docs/report.pdf')], 'other', new Map());
    expect(plan[0]).toMatchObject({ kind: 'create', name: 'report.pdf', to: 'other/report.pdf' });
  });

  it('直下の項目は、元の場所へだけ移す（戻す）。元のパスぴったりになる', () => {
    expect(checkTransfer('move', item(ALIAS, 'docs/report.pdf'), 'docs')).toEqual({ ok: true });
    const plan = planTransfer('move', [item(ALIAS, 'docs/report.pdf')], 'docs', new Map());
    expect(plan[0]).toMatchObject({ kind: 'create', to: 'docs/report.pdf' });
  });

  it('元の場所以外へは移せない（はっきり止める。送らない）', () => {
    const c = checkTransfer('move', item(ALIAS, 'docs/report.pdf'), 'other');
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.message).toContain('元の場所');
    const plan = planTransfer('move', [item(ALIAS, 'docs/report.pdf')], 'other', new Map());
    expect(plan[0]!.kind).toBe('blocked');
  });

  it('元の場所が直下なら、直下へだけ戻せる', () => {
    expect(checkTransfer('move', item(ALIAS, 'report.pdf'), '')).toEqual({ ok: true });
    const c = checkTransfer('move', item(ALIAS, 'report.pdf'), 'docs');
    expect(c.ok).toBe(false);
  });

  it('attachments の項目は、attachments へ戻せる（添付と共有の間の決まりは掛けない）', () => {
    const att = item('.trash/01HZX0000000000000000000AB--F1.png', 'attachments/F1.png', 'F1.png');
    expect(checkTransfer('move', att, 'attachments')).toEqual({ ok: true });
  });

  it('同じ名前があるときは、戻せない（上書きしない）。コピーは確認して上書き', () => {
    const dest = new Map([['report.pdf', ENTRY('report.pdf', 'docs/report.pdf')]]);
    const back = planTransfer('move', [item(ALIAS, 'docs/report.pdf')], 'docs', dest);
    expect(back[0]).toMatchObject({ kind: 'blocked' });
    expect(back[0]!.message).toContain('戻せません');
    const copy = planTransfer('copy', [item(ALIAS, 'docs/report.pdf')], 'docs', dest);
    expect(copy[0]).toMatchObject({ kind: 'overwrite', to: 'docs/report.pdf' });
  });

  it('ゴミ箱のルートは、動かせず、コピーもできない', () => {
    const root: TransferItem = { path: '.trash', kind: 'dir', trash: { where: 'root' } };
    expect(checkTransfer('move', root, '').ok).toBe(false);
    expect(checkTransfer('copy', root, 'docs').ok).toBe(false);
  });

  it('ゴミ箱の中身は、コピーはできるが、動かせない', () => {
    const inner: TransferItem = { path: '.trash/X--d/a.txt', kind: 'file', trash: { where: 'inside' } };
    expect(checkTransfer('copy', inner, 'docs')).toEqual({ ok: true });
    const c = checkTransfer('move', inner, 'docs');
    expect(c.ok).toBe(false);
  });

  it('失敗の一言は、元の名前で出す', () => {
    const msg = transferFailure({ done: [], failed: [{ item: item(ALIAS, 'docs/report.pdf'), message: 'x' }], skipped: [], declined: [] });
    expect(msg).toContain('「report.pdf」');
    expect(msg).not.toContain('01HZX');
  });

  it('ふつうの項目の決まりは変えない（既定の操作は従来どおり）', () => {
    expect(checkTransfer('move', f('docs/a.txt'), 'other')).toEqual({ ok: true });
    expect(planTransfer('copy', [f('docs/a.txt')], 'other', new Map())[0]).toMatchObject({ kind: 'create', to: 'other/a.txt' });
  });
});
