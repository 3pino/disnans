// @vitest-environment jsdom
// 設定の「ナビゲーションバー」の追加の一覧には、プラグインの navItem（コマンド）も出る（自動では並びに入らない。利用者が選んで追加する）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';

const nav = vi.hoisted(() => ({
  items: ['app:open-chat', 'app:open-settings'] as string[],
  labels: {} as Record<string, string>,
  set: (list: string[]) => {
    nav.items = list;
  },
  setLabel: () => {},
  resetLabels: () => {},
  reset: () => {},
}));
vi.mock('../lib/stores/navBar.svelte', () => ({
  navBar: {
    get items() {
      return nav.items;
    },
    get labels() {
      return nav.labels;
    },
    set: (l: string[]) => nav.set(l),
    setLabel: () => {},
    resetLabels: () => {},
    reset: () => {},
  },
}));

import NavBarSettings from './NavBarSettings.svelte';
import { registerNavItemCommand } from '../lib/plugins/navItemCommand';

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement;
beforeEach(() => {
  nav.items = ['app:open-chat', 'app:open-settings'];
  target = document.createElement('div');
  document.body.append(target);
});
afterEach(async () => {
  if (instance) await unmount(instance);
  instance = undefined;
  target.remove();
});

describe('設定の「ナビゲーションバー」の追加の一覧', () => {
  it('プラグインの navItem（コマンド）は、追加の一覧に出る（並びには自動で入らない）', async () => {
    const h = registerNavItemCommand({ id: 'dice:roll', label: 'サイコロ', icon: 'dice', onOpen: () => {} }, () => {});
    try {
      instance = mount(NavBarSettings, { target });
      flushSync();
      expect(target.textContent).not.toContain('サイコロ'); // 並んでいる項目には出ない
      (target.querySelector('.setting-list-add button') as HTMLButtonElement).click();
      await tick();
      const picks = [...target.querySelectorAll('.nav-bar-settings-pick')].map((x) => x.textContent?.trim() ?? '');
      expect(picks.some((t) => t.startsWith('サイコロ'))).toBe(true);
    } finally {
      h.close();
    }
  });
});
