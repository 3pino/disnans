// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createRawSnippet, flushSync, mount, unmount } from 'svelte';
import SettingRow from './SettingRow.svelte';

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;
afterEach(async () => {
  if (instance) await unmount(instance);
  target?.remove();
  instance = undefined;
  target = undefined;
});

function render(descriptionBelow = false, description: string | undefined = '補足') {
  target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(SettingRow, {
    target,
    props: {
      name: '項目', description, descriptionBelow,
      control: createRawSnippet(() => ({ render: () => '<span>操作</span>' })),
    },
  });
  flushSync();
  return target.querySelector<HTMLElement>('.setting-row')!;
}

describe('SettingRow の補足の配置（DOM の契約）', () => {
  it('既定では補足は名前の領域の中にある', () => {
    const row = render();
    expect(row.querySelector('.setting-row-info .setting-row-description')?.textContent).toBe('補足');
    expect(row.classList.contains('setting-row-wrap')).toBe(false);
  });

  it('別段を指定した補足は、名前と操作のあとに独立して置く', () => {
    const row = render(true);
    expect([...row.children].map((el) => el.className)).toEqual([
      'setting-row-info', 'setting-row-control', 'setting-row-description setting-row-description-below',
    ]);
    expect(row.querySelector('.setting-row-info .setting-row-description')).toBeNull();
    expect(row.classList.contains('setting-row-wrap')).toBe(true);
  });

  it('補足がなければ、別段を指定しても空の段を作らない', () => {
    const row = render(true, '');
    expect(row.querySelector('.setting-row-description')).toBeNull();
    expect(row.classList.contains('setting-row-wrap')).toBe(false);
  });
});
