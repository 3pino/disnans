// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe('一覧の表示方法と並び順（フォルダごと・この端末）', () => {
  it('既定は詳細・名前の昇順。変えたものは保存し、読み直すと戻る', async () => {
    const { explorerView } = await import('./explorerView.svelte');
    expect(explorerView.of('')).toEqual({ view: 'details', sortKey: 'name', sortOrder: 'asc' });
    explorerView.setView('docs', 'grid');
    explorerView.setSort('docs', 'modified', 'desc');
    vi.resetModules();
    const again = (await import('./explorerView.svelte')).explorerView;
    expect(again.of('docs')).toEqual({ view: 'grid', sortKey: 'modified', sortOrder: 'desc' });
  });

  it('フォルダごとに別。決めていないフォルダは、いちばん近い上のフォルダに従う', async () => {
    const { explorerView } = await import('./explorerView.svelte');
    explorerView.setView('docs', 'grid');
    expect(explorerView.of('').view).toBe('details');
    expect(explorerView.of('docs/a/b').view).toBe('grid');
    expect(explorerView.of('docsx').view).toBe('details');
    explorerView.setView('docs/a', 'details');
    expect(explorerView.of('docs/a/b').view).toBe('details');
    expect(explorerView.of('docs').view).toBe('grid');
  });

  it('旧版の端末全体の設定は、直下の設定として引き継ぐ（「一覧」は詳細）', async () => {
    localStorage.setItem('disnans.explorer.view', 'list');
    localStorage.setItem('disnans.explorer.sort', 'size:desc');
    const { explorerView } = await import('./explorerView.svelte');
    expect(explorerView.of('x')).toEqual({ view: 'details', sortKey: 'size', sortOrder: 'desc' });
  });

  it('知らない値・壊れた保存は既定に戻す（壊れた保存でも開ける）', async () => {
    localStorage.setItem('disnans.explorer.dirs', JSON.stringify({ a: { view: 'hologram', sortKey: 'name', sortOrder: 'asc' }, b: 3 }));
    const { explorerView } = await import('./explorerView.svelte');
    expect(explorerView.of('a').view).toBe('details');
    expect(explorerView.of('b').sortKey).toBe('name');
    localStorage.setItem('disnans.explorer.dirs', '{');
    vi.resetModules();
    expect((await import('./explorerView.svelte')).explorerView.of('').view).toBe('details');
  });
});
