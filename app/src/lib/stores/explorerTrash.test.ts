// ゴミ箱ストアの単体テスト
// - 世代ガード（stale レスポンスの破棄）
// - loading 中 invalidate → pendingReload → 完了後に 1 回だけ再 load（並列不可）
// - invalidate: open/closed での即再取得 vs idle
// - onServerChange → reset
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  trashList: vi.fn(async (): Promise<import('../protocol/SharedTrashEntry').SharedTrashEntry[]> => []),
  serverChangeHandlers: [] as (() => void)[],
}));

vi.mock('../transport/shared', () => ({
  sharedApi: { trashList: h.trashList },
}));

vi.mock('../config', () => ({
  onServerChange: (fn: () => void) => {
    h.serverChangeHandlers.push(fn);
    return () => {};
  },
  getServerUrl: () => 'http://localhost:3000',
}));

vi.mock('../fileLink', () => ({
  attachmentActionText: (e: unknown) => String(e),
}));

function makeEntry(id: string): import('../protocol/SharedTrashEntry').SharedTrashEntry {
  return { id, original_path: `file_${id}.txt`, kind: 'file', size: 1, deleted_at: 0 };
}

describe('explorerTrash store', () => {
  beforeEach(() => {
    h.trashList.mockReset();
    h.serverChangeHandlers.length = 0;
    vi.resetModules();
  });

  it('世代ガード: reset 中の load 結果を捨てる（stale 書き戻しなし）', async () => {
    const { explorerTrash } = await import('./explorerTrash.svelte');
    let resolveFirst!: (v: import('../protocol/SharedTrashEntry').SharedTrashEntry[]) => void;
    h.trashList.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }));

    const p1 = explorerTrash.load();
    expect(explorerTrash.state.kind).toBe('loading');

    // reset → gen 進行
    explorerTrash.reset();
    expect(explorerTrash.state.kind).toBe('idle');

    // 1 回目のレスポンスが届いても stale → 書き戻さない
    resolveFirst([makeEntry('a')]);
    await p1;
    expect(explorerTrash.state.kind).toBe('idle');
  });

  it('reset 前の応答は、新しい取得に届いた invalidate を消費しない', async () => {
    const { explorerTrash } = await import('./explorerTrash.svelte');
    type Entries = import('../protocol/SharedTrashEntry').SharedTrashEntry[];
    let oldResolve!: (v: Entries) => void;
    let currentResolve!: (v: Entries) => void;
    let latestResolve!: (v: Entries) => void;
    h.trashList
      .mockImplementationOnce(() => new Promise((r) => { oldResolve = r; }))
      .mockImplementationOnce(() => new Promise((r) => { currentResolve = r; }))
      .mockImplementationOnce(() => new Promise((r) => { latestResolve = r; }));

    const old = explorerTrash.load();
    explorerTrash.reset();
    explorerTrash.open = true;
    const current = explorerTrash.load();
    explorerTrash.invalidate();

    oldResolve([makeEntry('old')]);
    await old;
    expect(h.trashList).toHaveBeenCalledTimes(2);
    expect(explorerTrash.state.kind).toBe('loading');

    currentResolve([makeEntry('outdated')]);
    await current;
    expect(h.trashList).toHaveBeenCalledTimes(3);
    latestResolve([makeEntry('latest')]);
    await vi.waitFor(() => expect(explorerTrash.state).toMatchObject({
      kind: 'ok', entries: [{ id: 'latest' }],
    }));
  });

  it('loading 中の invalidate → pendingReload → 完了後に 1 回だけ再 load', async () => {
    const { explorerTrash } = await import('./explorerTrash.svelte');
    let resolveFirst!: (v: import('../protocol/SharedTrashEntry').SharedTrashEntry[]) => void;
    h.trashList
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; })) // 1 回目（pending）
      .mockResolvedValueOnce([makeEntry('b')]); // 2 回目（再 load）

    explorerTrash.open = true;
    const p1 = explorerTrash.load();
    expect(explorerTrash.state.kind).toBe('loading');
    expect(h.trashList).toHaveBeenCalledTimes(1);

    // loading 中に invalidate → pending 化（並列リクエストしない）
    explorerTrash.invalidate();
    expect(h.trashList).toHaveBeenCalledTimes(1); // まだ 1 回のみ

    // 1 回目完了（stale）→ _afterLoad で pendingReload を消費して再 load 開始
    resolveFirst([makeEntry('a')]);
    await p1;
    // 再 load 完了を待つ（最終的に 'b' になること。'a' は採用しない）
    await vi.waitFor(() => {
      if (explorerTrash.state.kind !== 'ok') throw new Error('not ok');
      if (explorerTrash.state.entries[0]?.id !== 'b') throw new Error('still has old data');
    });
    if (explorerTrash.state.kind === 'ok') {
      expect(explorerTrash.state.entries[0].id).toBe('b'); // 新しいデータ（'a' は stale で破棄）
    }
    // 全部で 2 回のみ（並列にしない）
    expect(h.trashList).toHaveBeenCalledTimes(2);
  });

  it('loading 中の invalidate が複数回届いても 1 回だけ再 load', async () => {
    const { explorerTrash } = await import('./explorerTrash.svelte');
    let resolveFirst!: (v: import('../protocol/SharedTrashEntry').SharedTrashEntry[]) => void;
    h.trashList
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
      .mockResolvedValueOnce([makeEntry('final')]);

    explorerTrash.open = true;
    const p1 = explorerTrash.load();
    explorerTrash.invalidate(); // 1 回目
    explorerTrash.invalidate(); // 2 回目
    explorerTrash.invalidate(); // 3 回目

    resolveFirst([]);
    await p1;
    await vi.waitFor(() => expect(explorerTrash.state.kind).toBe('ok'));
    // load は合計 2 回のみ
    expect(h.trashList).toHaveBeenCalledTimes(2);
  });

  it('invalidate: open=false なら idle に戻す（再 load しない）', async () => {
    const { explorerTrash } = await import('./explorerTrash.svelte');
    h.trashList.mockResolvedValueOnce([makeEntry('a')]);
    await explorerTrash.load();
    expect(explorerTrash.state.kind).toBe('ok');

    explorerTrash.open = false;
    explorerTrash.invalidate();
    expect(explorerTrash.state.kind).toBe('idle');
    // 追加の load は起きない
    expect(h.trashList).toHaveBeenCalledTimes(1);
  });

  it('invalidate: open=true なら即再取得する', async () => {
    const { explorerTrash } = await import('./explorerTrash.svelte');
    h.trashList
      .mockResolvedValueOnce([makeEntry('a')])
      .mockResolvedValueOnce([makeEntry('b')]);

    explorerTrash.open = true;
    await explorerTrash.load();

    explorerTrash.invalidate();
    await vi.waitFor(() => {
      if (explorerTrash.state.kind !== 'ok') throw new Error('not ok yet');
      return explorerTrash.state.entries[0]?.id === 'b';
    });
    if (explorerTrash.state.kind === 'ok') {
      expect(explorerTrash.state.entries[0].id).toBe('b');
    }
  });

  it('onServerChange → reset が呼ばれ、一覧が idle になる', async () => {
    const { explorerTrash } = await import('./explorerTrash.svelte');
    h.trashList.mockResolvedValueOnce([makeEntry('a')]);
    await explorerTrash.load();
    expect(explorerTrash.state.kind).toBe('ok');

    for (const fn of h.serverChangeHandlers) fn();
    expect(explorerTrash.state.kind).toBe('idle');
    expect(explorerTrash.open).toBe(false);
  });

  it('removeEntry: 指定した ID だけを一覧から外す', async () => {
    const { explorerTrash } = await import('./explorerTrash.svelte');
    h.trashList.mockResolvedValueOnce([makeEntry('a'), makeEntry('b'), makeEntry('c')]);
    await explorerTrash.load();
    explorerTrash.removeEntry('b');
    if (explorerTrash.state.kind === 'ok') {
      expect(explorerTrash.state.entries.map((e) => e.id)).toEqual(['a', 'c']);
    }
  });

  it('loading 中に server 切替 → stale 結果が idle を上書きしない', async () => {
    const { explorerTrash } = await import('./explorerTrash.svelte');
    let resolveFirst!: (v: import('../protocol/SharedTrashEntry').SharedTrashEntry[]) => void;
    h.trashList.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }));

    const p1 = explorerTrash.load();
    // サーバー切替シミュレート
    for (const fn of h.serverChangeHandlers) fn();
    expect(explorerTrash.state.kind).toBe('idle');

    // 古いリクエストのレスポンスが届いても idle を上書きしない
    resolveFirst([makeEntry('old')]);
    await p1;
    expect(explorerTrash.state.kind).toBe('idle');
  });
});
