// @vitest-environment jsdom
// フォルダごとの表示・並び順（explorerView）。保存はデバイスの設定 explorerDirs（キャッシュ・サーバー・旧い保存からの取り込み）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceApi } from '../transport/device';

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

const GRID = { view: 'grid', sortKey: 'modified', sortOrder: 'desc' };

async function fresh() {
  return (await import('./explorerView.svelte')).explorerView;
}

describe('一覧の表示方法と並び順（フォルダごと・この端末）', () => {
  it('既定は詳細・名前の昇順。変えたものは、この端末の設定（キャッシュ）に残り、読み直すと戻る', async () => {
    const explorerView = await fresh();
    expect(explorerView.of('')).toEqual({ view: 'details', sortKey: 'name', sortOrder: 'asc' });
    explorerView.setView('docs', 'grid');
    explorerView.setSort('docs', 'modified', 'desc');
    const cached = JSON.parse(localStorage.getItem('disnans.devicePrefs') ?? '{}') as { explorerDirs?: Record<string, unknown> };
    expect(cached.explorerDirs?.docs).toEqual(GRID);
    vi.resetModules();
    expect((await fresh()).of('docs')).toEqual(GRID);
  });

  it('フォルダごとに別。決めていないフォルダは、いちばん近い上のフォルダに従う', async () => {
    const explorerView = await fresh();
    explorerView.setView('docs', 'grid');
    expect(explorerView.of('').view).toBe('details');
    expect(explorerView.of('docs/a/b').view).toBe('grid');
    expect(explorerView.of('docsx').view).toBe('details');
    explorerView.setView('docs/a', 'details');
    expect(explorerView.of('docs/a/b').view).toBe('details');
    expect(explorerView.of('docs').view).toBe('grid');
  });

  it('知らない値・壊れた保存は既定に戻す（壊れた保存でも開ける）', async () => {
    localStorage.setItem('disnans.devicePrefs', JSON.stringify({ explorerDirs: { a: { view: 'hologram', sortKey: 'name', sortOrder: 'asc' }, b: 3 } }));
    const explorerView = await fresh();
    expect(explorerView.of('a').view).toBe('details');
    expect(explorerView.of('b').sortKey).toBe('name');
    localStorage.setItem('disnans.devicePrefs', '{');
    vi.resetModules();
    expect((await fresh()).of('').view).toBe('details');
  });

  it('reset は保存を消す（既定に戻る）', async () => {
    const explorerView = await fresh();
    explorerView.setView('docs', 'grid');
    explorerView.reset();
    expect(explorerView.of('docs').view).toBe('details');
  });
});

describe('旧い保存からの取り込み（この端末のキャッシュが無いときだけ）', () => {
  it('旧い端末全体の設定は、ルートの設定として引き継ぐ（「一覧」は詳細）', async () => {
    localStorage.setItem('disnans.explorer.view', 'list');
    localStorage.setItem('disnans.explorer.sort', 'size:desc');
    const explorerView = await fresh();
    expect(explorerView.of('x')).toEqual({ view: 'details', sortKey: 'size', sortOrder: 'desc' });
  });

  it('旧い一覧（disnans.explorer.dirs）は、フォルダごとにそのまま引き継ぐ。旧いキーは消さない', async () => {
    localStorage.setItem('disnans.explorer.dirs', JSON.stringify({ docs: GRID }));
    const explorerView = await fresh();
    expect(explorerView.of('docs')).toEqual(GRID);
    expect(localStorage.getItem('disnans.explorer.dirs')).not.toBeNull();
  });

  it('この端末のキャッシュに表示が有れば、旧い保存は使わない', async () => {
    localStorage.setItem('disnans.explorer.dirs', JSON.stringify({ docs: GRID }));
    localStorage.setItem('disnans.devicePrefs', JSON.stringify({ explorerDirs: {} }));
    const explorerView = await fresh();
    expect(explorerView.of('docs').view).toBe('details');
  });

  it('表示だけを持たない古いキャッシュには、旧い保存を足す（ほかの項目のキャッシュは保つ）', async () => {
    localStorage.setItem('disnans.explorer.dirs', JSON.stringify({ docs: GRID }));
    localStorage.setItem('disnans.devicePrefs', JSON.stringify({ hideNavigationBar: true }));
    const explorerView = await fresh();
    expect(explorerView.of('docs')).toEqual(GRID);
    const store = (await import('./deviceSettings.svelte')).deviceSettings;
    expect(store.hideNavigationBar).toBe(true);
  });
});

describe('サーバーへの取り込み（DeviceSettings。サーバーに表示が無いときだけ、旧い保存を一度読む）', () => {
  async function storeWith(prefs: Record<string, unknown>, saved: boolean) {
    const { DeviceSettings } = await import('./deviceSettings.svelte');
    const writes: Record<string, unknown>[] = [];
    const api = {
      id: async () => 'dev-1',
      register: async () => {},
      read: async () => ({ prefs, updatedAt: 1, saved }),
      write: async (_id: string, body: Record<string, unknown>) => {
        writes.push(body);
        return { prefs: body, updatedAt: 2, saved: true };
      },
    } as unknown as DeviceApi;
    const store = new DeviceSettings({
      api,
      get: (k) => localStorage.getItem(k),
      set: (k, v) => (v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v)),
      defaultName: () => 'テスト',
      now: () => 0,
    });
    return { store, writes };
  }

  it('サーバーに表示が無い（項目が無い）ときは、旧い保存を取り込んで送る', async () => {
    localStorage.setItem('disnans.explorer.dirs', JSON.stringify({ docs: GRID }));
    const { store, writes } = await storeWith({ inputId: '' }, true);
    await store.start();
    expect(store.raw.explorerDirs).toEqual({ docs: GRID });
    expect(writes.at(-1)?.explorerDirs).toEqual({ docs: GRID });
  });

  it('サーバーが既定で補った空の表示（explorerDirs: {}）のときも、旧い保存を取り込んで送る', async () => {
    localStorage.setItem('disnans.explorer.dirs', JSON.stringify({ docs: GRID }));
    const { store, writes } = await storeWith({ inputId: '', explorerDirs: {} }, true);
    await store.start();
    expect(store.raw.explorerDirs).toEqual({ docs: GRID });
    expect(writes.at(-1)?.explorerDirs).toEqual({ docs: GRID });
  });

  it('サーバーに表示が有れば、旧い保存は上書きしない', async () => {
    localStorage.setItem('disnans.explorer.dirs', JSON.stringify({ docs: GRID }));
    const { store, writes } = await storeWith({ explorerDirs: { other: GRID } }, true);
    await store.start();
    expect(store.raw.explorerDirs).toEqual({ other: GRID });
    expect(writes).toEqual([]);
  });

  it('デバイスがまだ保存していない（saved: false）ときは、旧い保存から始めて送る', async () => {
    localStorage.setItem('disnans.explorer.view', 'grid');
    const { store, writes } = await storeWith({}, false);
    await store.start();
    expect(writes.at(-1)?.explorerDirs).toEqual({ '': { view: 'grid', sortKey: 'name', sortOrder: 'asc' } });
  });
});
