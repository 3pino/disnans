// @vitest-environment jsdom
// プラグインのナビの項目（ui.navItem）の店: 足す・外す（同じ参照だけ）・バッジ・view からの選び
import { describe, expect, it } from 'vitest';
import { pluginNav } from './pluginNav.svelte';

const entry = (id: string, over: { view?: string | null } = {}) => ({
  id: `ui-nav:${id}`,
  label: id,
  icon: 'folder',
  badge: null,
  view: null,
  onOpen: null,
  ...over,
});

describe('pluginNav', () => {
  it('足す・同じ ID は足さない・外すのは自分の項目だけ', () => {
    const offA = pluginNav.add(entry('a'));
    expect(offA).not.toBeNull();
    expect(pluginNav.add(entry('a'))).toBeNull();
    expect(pluginNav.find('ui-nav:a')?.label).toBe('a');
    offA!();
    expect(pluginNav.find('ui-nav:a')).toBeUndefined();
    offA!(); // 何度呼んでもよい
  });

  it('外すのは、同じ ID でも自分の印のものだけ', () => {
    const first = pluginNav.add(entry('x'));
    first!();
    const second = pluginNav.add(entry('x', { view: 'v2' }));
    first!(); // 古い解除は、いまの項目を消さない
    expect(pluginNav.find('ui-nav:x')?.view).toBe('v2');
    second!();
  });

  it('バッジを変えられる（ほかの項目は変わらない）', () => {
    const offB = pluginNav.add(entry('b'));
    const offC = pluginNav.add(entry('c'));
    pluginNav.setBadge('ui-nav:b', 3);
    expect(pluginNav.find('ui-nav:b')?.badge).toBe(3);
    expect(pluginNav.find('ui-nav:c')?.badge).toBeNull();
    pluginNav.setBadge('ui-nav:b', null);
    expect(pluginNav.find('ui-nav:b')?.badge).toBeNull();
    offB!();
    offC!();
  });

  it('view からは、その view の項目を探す', () => {
    const off = pluginNav.add(entry('files', { view: 'files-view' }));
    expect(pluginNav.forView(null, 'files-view')?.id).toBe('ui-nav:files');
    expect(pluginNav.forView(null, 'nope')).toBeUndefined();
    off!();
  });
});
