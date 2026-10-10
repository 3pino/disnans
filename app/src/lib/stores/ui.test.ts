import { describe, expect, it } from 'vitest';
import { ui } from './ui.svelte';

describe('ui.backLayers', () => {
  it('画像の全画面は一番上の層になる（戻る操作で最初に閉じる）', () => {
    ui.tab = 'chat';
    ui.panel = { kind: 'thread', id: 't1' };
    ui.searchOpen = true;
    ui.lightbox = { src: 'x', alt: 'x.png', downloadUrl: 'x' };

    const layers = ui.backLayers();
    expect(layers).toHaveLength(3);
    // 上の層から閉じるので、最後の層（全画面）を閉じると検索とパネルはまだ開いたまま
    layers.at(-1)?.();
    expect(ui.lightbox).toBeNull();
    expect(ui.searchOpen).toBe(true);
    expect(ui.panel).not.toBeNull();

    ui.searchOpen = false;
    ui.panel = null;
  });

  it('何も開いていなければ層はない', () => {
    ui.tab = 'chat';
    ui.panel = null;
    ui.searchOpen = false;
    ui.lightbox = null;
    expect(ui.backLayers()).toHaveLength(0);
  });
});
