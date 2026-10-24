// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import NavBar, { type NavBarItem } from './NavBar.svelte';

// 選んでいる項目は、どの項目でも同じ規則で 1 つだけ（共有フォルダも、チャット・設定と同じ）
let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;
afterEach(async () => {
  if (instance) await unmount(instance);
  target?.remove();
  instance = undefined;
  target = undefined;
});

const items: NavBarItem[] = [
  { id: 'app:open-chat', label: 'Chat', icon: 'disnans-logo' },
  { id: 'app:open-settings', label: 'Settings', icon: 'settings' },
  { id: 'app:open-files', label: '共有フォルダを開く', icon: 'folder-open' },
  { id: 'plugin:voice', label: '音声', icon: 'mic' },
];

function render(selected: string | undefined): HTMLElement {
  target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(NavBar, { target, props: { items, selected, onselect: () => {} } });
  flushSync();
  return target;
}

describe('ナビバーの選んでいる項目（ui/NavBar）', () => {
  it.each(items.map((i) => [i.id]))('%s を選ぶと、その項目だけが選ばれた表示になる', (id) => {
    const el = render(id);
    const selected = [...el.querySelectorAll('.nav-bar-item-selected')];
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain(items.find((i) => i.id === id)!.label);
    const current = el.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0]).toBe(selected[0]);
  });

  it('選ばれていない項目には、選んだ表示も aria-current も付かない（共有フォルダも同じ）', () => {
    const el = render('app:open-files');
    const files = [...el.querySelectorAll('.nav-bar-item')].find((b) => b.textContent?.includes('共有フォルダ'));
    expect(files?.classList.contains('nav-bar-item-selected')).toBe(true);
    const chat = [...el.querySelectorAll('.nav-bar-item')].find((b) => b.textContent?.includes('Chat'));
    expect(chat?.classList.contains('nav-bar-item-selected')).toBe(false);
    expect(chat?.getAttribute('aria-current')).toBeNull();
  });
});
