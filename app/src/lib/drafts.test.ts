import { describe, expect, it } from 'vitest';
import { draftKey, draftPlace, draftLocation, flushDraftSaves, loadDraft, loadDraftAt, saveDraft, saveDraftAt, type DraftStore } from './drafts';
import type { SharedStorage } from './sharedStorage';

function memoryStore(): DraftStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: (k) => map.get(k) ?? null,
    set: (k, v) => {
      if (v === null) map.delete(k);
      else map.set(k, v);
    },
  };
}

describe('下書きのキー', () => {
  it('メインチャットとスレッドで別のキーになり、ユーザーごとに分かれる', () => {
    expect(draftPlace(null)).toBe('main');
    expect(draftPlace('t1')).toBe('thread:t1');
    expect(draftKey('u1', null)).not.toBe(draftKey('u1', 't1'));
    expect(draftKey('u1', 't1')).not.toBe(draftKey('u2', 't1'));
    expect(draftKey('u1', 't1')).toBe(draftKey('u1', 't1'));
  });
});

describe('server namespace draft adapter', () => {
  it('does not interpret an unreadable shared draft without a backup as an empty draft', async () => {
    const location = draftLocation('https://unreadable.example', 'u1', null);
    const shared = {
      getDraftWithStatus: async () => ({ value: null, status: 'legacy-fallback' as const }),
    } as unknown as SharedStorage;
    await expect(loadDraftAt(location, shared)).rejects.toThrow('共有下書きを読み込めず');
  });

  it('allows a verified empty draft and an available legacy backup to load', async () => {
    const location = draftLocation('https://verified-empty.example', 'u1', null);
    const empty = { getDraftWithStatus: async () => ({ value: null, status: 'shared' as const }) } as unknown as SharedStorage;
    const backup = { getDraftWithStatus: async () => ({ value: 'backup', status: 'legacy-fallback' as const }) } as unknown as SharedStorage;
    expect(await loadDraftAt(location, empty)).toBe('');
    expect(await loadDraftAt(location, backup)).toBe('backup');
  });
  it('builds a location with source server provenance and loads asynchronously', async () => {
    const location = draftLocation('https://chat.example', '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'thread-01');
    expect(location).toEqual({
      serverUrl: 'https://chat.example',
      userId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      place: 'thread:thread-01',
      legacyKey: 'disnans.draft.01ARZ3NDEKTSV4RRFFQ69G5FAV.thread:thread-01',
    });
    const calls: unknown[][] = [];
    const shared = {
      getDraft: async (...args: unknown[]) => { calls.push(args); return 'shared body'; },
      setDraft: async () => ({ status: 'shared' as const }),
    } as unknown as SharedStorage;
    expect(await loadDraftAt(location, shared)).toBe('shared body');
    expect(calls).toEqual([['https://chat.example', '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'thread:thread-01']]);
  });

  it('prefers a save that starts while an async draft read is pending', async () => {
    const location = draftLocation('https://race.example', '01ARZ3NDEKTSV4RRFFQ69G5FAV', null);
    let resolveRead!: (value: string | null) => void;
    let resolveWrite!: (value: { status: 'shared' }) => void;
    const shared = {
      getDraft: () => new Promise<string | null>((resolve) => { resolveRead = resolve; }),
      setDraft: () => new Promise<{ status: 'shared' }>((resolve) => { resolveWrite = resolve; }),
    } as unknown as SharedStorage;

    const loading = loadDraftAt(location, shared);
    await Promise.resolve();
    const saving = saveDraftAt(location, 'new body', shared);
    await Promise.resolve();
    resolveRead('stale body');
    expect(await loading).toBe('new body');
    resolveWrite({ status: 'shared' });
    await saving;
  });

  it('keeps a save that completed during a draft read ahead of the stale read result', async () => {
    const location = draftLocation('https://completed-race.example', '01ARZ3NDEKTSV4RRFFQ69G5FAV', null);
    let resolveRead!: (value: string | null) => void;
    const shared = {
      getDraft: () => new Promise<string | null>((resolve) => { resolveRead = resolve; }),
      setDraft: async () => ({ status: 'shared' as const }),
    } as unknown as SharedStorage;

    const loading = loadDraftAt(location, shared);
    await Promise.resolve();
    await saveDraftAt(location, 'new body', shared);
    resolveRead('stale body');
    expect(await loading).toBe('new body');
  });

  it('does not let an older reversed completion clear a newer failed save', async () => {
    const location = draftLocation('https://order.example', '01ARZ3NDEKTSV4RRFFQ69G5FAV', null);
    const resolves: Array<(value: { status: 'shared' | 'legacy-fallback' }) => void> = [];
    const shared = {
      setDraft: () => new Promise<{ status: 'shared' | 'legacy-fallback' }>((resolve) => resolves.push(resolve)),
    } as unknown as SharedStorage;

    const older = saveDraftAt(location, 'older', shared);
    const newer = saveDraftAt(location, 'newer', shared);
    await Promise.resolve();
    await Promise.resolve();
    resolves[0]({ status: 'shared' });
    await older;
    resolves[1]({ status: 'legacy-fallback' });
    await newer;
    await expect(flushDraftSaves()).rejects.toThrow('not saved to shared storage');
    const retry = saveDraftAt(location, 'latest body', shared);
    await Promise.resolve();
    resolves[2]({ status: 'shared' });
    await retry;
    await expect(flushDraftSaves()).resolves.toBeUndefined();
  });

  it('does not let an older fallback completion invalidate a newer shared success', async () => {
    const location = draftLocation('https://reverse.example', '01ARZ3NDEKTSV4RRFFQ69G5FAV', null);
    const resolves: Array<(value: { status: 'shared' | 'legacy-fallback' }) => void> = [];
    const shared = {
      setDraft: () => new Promise<{ status: 'shared' | 'legacy-fallback' }>((resolve) => resolves.push(resolve)),
    } as unknown as SharedStorage;

    const older = saveDraftAt(location, 'older', shared);
    const newer = saveDraftAt(location, 'newer', shared);
    await Promise.resolve();
    await Promise.resolve();
    resolves[1]({ status: 'shared' });
    await newer;
    resolves[0]({ status: 'legacy-fallback' });
    await older;
    await expect(flushDraftSaves()).resolves.toBeUndefined();
  });

  it('keeps a failed desktop save available after its composer is unmounted', async () => {
    const location = draftLocation('https://chat.example', '01ARZ3NDEKTSV4RRFFQ69G5FAV', null);
    let fail = true;
    const shared = {
      getDraft: async () => 'old shared body',
      setDraft: async () => {
        if (fail) throw new Error('storage failed');
        return { status: 'shared' as const };
      },
    } as unknown as SharedStorage;

    await expect(saveDraftAt(location, 'unsaved body', shared)).rejects.toThrow('storage failed');
    expect(await loadDraftAt(location, shared)).toBe('unsaved body');
    await expect(flushDraftSaves()).rejects.toThrow('not saved to shared storage');
    fail = false;
    expect(await saveDraftAt(location, 'unsaved body', shared)).toEqual({ status: 'shared' });
    await expect(flushDraftSaves()).resolves.toBeUndefined();
  });

  it('blocks a requested reload when an autosave is only local fallback', async () => {
    const location = draftLocation('https://chat.example', '01ARZ3NDEKTSV4RRFFQ69G5FAV', null);
    const shared = {
      setDraft: async () => ({ status: 'legacy-fallback' as const }),
    } as unknown as SharedStorage;
    await saveDraftAt(location, 'body', shared);
    await expect(flushDraftSaves()).rejects.toThrow('not saved to shared storage');
    const recovery = { setDraft: async () => ({ status: 'shared' as const }) } as unknown as SharedStorage;
    await saveDraftAt(location, 'body', recovery);
    await expect(flushDraftSaves()).resolves.toBeUndefined();
  });

  it('exposes desktop and browser save outcomes', async () => {
    const location = draftLocation('https://chat.example', '01ARZ3NDEKTSV4RRFFQ69G5FAV', null);
    const shared = {
      setDraft: async (_server: string, _user: string, _place: string, body: string | null) =>
        ({ status: body === 'draft' ? 'legacy-fallback' as const : 'shared' as const }),
    } as unknown as SharedStorage;
    expect(await saveDraftAt(location, 'draft', shared)).toEqual({ status: 'legacy-fallback' });

    expect(await saveDraftAt(location, 'body')).toEqual({ status: 'local' });
  });
});

describe('下書きの保存と読み込み', () => {
  it('保存した文章を読み直せる（場所を切り替えても別々に残る）', () => {
    const s = memoryStore();
    const main = draftKey('u1', null);
    const thread = draftKey('u1', 'a');
    saveDraft(main, 'メインの文\n二行目', s);
    saveDraft(thread, 'スレッドの文', s);
    expect(loadDraft(main, s)).toBe('メインの文\n二行目');
    expect(loadDraft(thread, s)).toBe('スレッドの文');
  });

  it('保存していなければ空文字', () => {
    expect(loadDraft(draftKey('u1', null), memoryStore())).toBe('');
  });

  it('空や空白だけになったら消す（送信したあとも同じ）', () => {
    const s = memoryStore();
    const key = draftKey('u1', null);
    saveDraft(key, 'あ', s);
    saveDraft(key, '  \n ', s);
    expect(s.map.has(key)).toBe(false);
    expect(loadDraft(key, s)).toBe('');
  });

  it('空白を含む文章はそのまま残す（先頭の空白も消さない）', () => {
    const s = memoryStore();
    saveDraft('k', '  x  ', s);
    expect(loadDraft('k', s)).toBe('  x  ');
  });
});
