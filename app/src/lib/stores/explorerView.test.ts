// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe('一覧の表示方法と並び順（この端末）', () => {
  it('既定は一覧・名前の昇順。変えたものは保存し、読み直すと戻る', async () => {
    const { explorerView } = await import('./explorerView.svelte');
    expect(explorerView.view).toBe('list');
    expect(explorerView.sortKey).toBe('name');
    explorerView.setView('grid');
    explorerView.setSort('modified', 'desc');
    vi.resetModules();
    const again = (await import('./explorerView.svelte')).explorerView;
    expect(again.view).toBe('grid');
    expect(again.sortKey).toBe('modified');
    expect(again.sortOrder).toBe('desc');
  });

  it('知らない値は既定に戻す（壊れた保存でも開ける）', async () => {
    localStorage.setItem('disnans.explorer.view', 'hologram');
    localStorage.setItem('disnans.explorer.sort', 'size:sideways');
    const { explorerView } = await import('./explorerView.svelte');
    expect(explorerView.view).toBe('list');
    expect(explorerView.sortKey).toBe('name');
    expect(explorerView.sortOrder).toBe('asc');
  });
});
