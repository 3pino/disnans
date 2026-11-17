// @vitest-environment jsdom
// 旧い保存先の取り込み（組み込みのエクスプローラーだけ。最初の saveData までの一度きり）
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../call/instance.svelte', () => ({ callApi: {} }));

import { EXPLORER_PLUGIN_ID, legacyTakenKey, PluginHost } from './host.svelte';
import { LEGACY_EXPLORER_KEYS } from '../explorerDirs';

const legacyOf = (host: PluginHost, id: string) => (host as unknown as { legacyDataFor(id: string): unknown }).legacyDataFor(id);

beforeEach(() => localStorage.clear());

describe('旧い保存先の取り込み', () => {
  it('組み込みのエクスプローラーには、以前の一覧の表示を返す。ほかのプラグインには返さない', () => {
    localStorage.setItem(LEGACY_EXPLORER_KEYS.view, 'grid');
    const host = new PluginHost();
    expect(legacyOf(host, EXPLORER_PLUGIN_ID)).toEqual({ '': expect.objectContaining({ view: 'grid' }) });
    expect(legacyOf(host, 'dice')).toBeNull();
  });

  it('取り込んだ印が付いたら、もう返さない（一度きり）', () => {
    localStorage.setItem(LEGACY_EXPLORER_KEYS.view, 'grid');
    localStorage.setItem(legacyTakenKey(EXPLORER_PLUGIN_ID), '1');
    expect(legacyOf(new PluginHost(), EXPLORER_PLUGIN_ID)).toBeNull();
  });

  it('以前の保存が無ければ null', () => {
    expect(legacyOf(new PluginHost(), EXPLORER_PLUGIN_ID)).toBeNull();
  });
});
