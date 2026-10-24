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

// 削除モード: 操作部品（control）は残して隠し、× をその上に重ねる（行の高さを変えないため）。ondelete が無い行は × を出さない
describe('SettingRow の削除モード', () => {
  function renderDeleting(props: { deleting: boolean; ondelete?: () => void }) {
    target = document.createElement('div');
    document.body.appendChild(target);
    instance = mount(SettingRow, {
      target,
      props: {
        name: '項目',
        deleteLabel: '項目を外す',
        control: createRawSnippet(() => ({ render: () => '<span class="ctl">操作</span>' })),
        ...props,
      },
    });
    flushSync();
    return target.querySelector<HTMLElement>('.setting-row')!;
  }

  it('削除モードでないときは、操作部品をそのまま出す（隠さない・× は出さない）', () => {
    const row = renderDeleting({ deleting: false, ondelete: () => {} });
    expect(row.querySelector('.ctl')).not.toBeNull();
    expect(row.querySelector('.setting-row-control-hidden')).toBeNull();
    expect(row.querySelector('.setting-row-delete')).toBeNull();
  });

  it('削除モードでは、操作部品を隠したまま残し（高さを保つ）、その上に × を出して、押すと ondelete を呼ぶ', () => {
    let called = 0;
    const row = renderDeleting({ deleting: true, ondelete: () => called++ });
    expect(row.querySelector('.ctl')).not.toBeNull();
    expect(row.querySelector('.setting-row-control-hidden .ctl')).not.toBeNull();
    const btn = row.querySelector<HTMLButtonElement>('.setting-row-control .setting-row-delete');
    expect(btn?.getAttribute('aria-label')).toBe('項目を外す');
    btn!.click();
    expect(called).toBe(1);
  });

  it('削除モードでも、削除できない行（ondelete なし）は × を出さず、操作部品だけ隠す', () => {
    const row = renderDeleting({ deleting: true });
    expect(row.querySelector('.setting-row-control-hidden .ctl')).not.toBeNull();
    expect(row.querySelector('.setting-row-delete')).toBeNull();
  });
});
