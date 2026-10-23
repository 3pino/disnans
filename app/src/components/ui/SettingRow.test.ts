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

function render(props: { description?: string; control?: boolean } = {}) {
  target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(SettingRow, {
    target,
    props: {
      name: '項目',
      description: props.description,
      ...(props.control === false ? {} : { control: createRawSnippet(() => ({ render: () => '<span>操作</span>' })) }),
    },
  });
  flushSync();
  return target.querySelector<HTMLElement>('.setting-row')!;
}

// プラグインの ui.setting（lib/plugins/ui.ts）も同じ DOM を作る。折り返しは CSS（app.css）が受け持つので、DOM は 1 種類だけ
describe('SettingRow の DOM の契約', () => {
  it('名前と説明は info の中、操作は info の次に並ぶ', () => {
    const row = render({ description: '補足' });
    expect([...row.children].map((el) => el.className)).toEqual(['setting-row-info', 'setting-row-control']);
    expect(row.querySelector('.setting-row-info > .setting-row-name')?.textContent).toBe('項目');
    expect(row.querySelector('.setting-row-info > .setting-row-description')?.textContent).toBe('補足');
  });

  it('説明がなければ説明の要素を作らない', () => {
    expect(render().querySelector('.setting-row-description')).toBeNull();
  });

  it('操作がなければ control を作らない', () => {
    expect(render({ control: false }).querySelector('.setting-row-control')).toBeNull();
  });
});
