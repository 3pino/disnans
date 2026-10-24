// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRawSnippet, flushSync, mount, unmount } from 'svelte';
import MenuItem from './MenuItem.svelte';

// 押せない項目の理由は、項目名の下に常に出す（title だけに頼らない。Android でも見える）
let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;
afterEach(async () => {
  if (instance) await unmount(instance);
  target?.remove();
  instance = undefined;
  target = undefined;
});

function renderItem(props: { disabled?: boolean; reason?: string; onclick?: () => void }): HTMLButtonElement {
  target = document.createElement('div');
  document.body.appendChild(target);
  const children = createRawSnippet(() => ({ render: () => '<span class="label-text">名前を変更</span>' }));
  instance = mount(MenuItem, { target, props: { ...props, children } });
  flushSync();
  return target.querySelector('button')!;
}

describe('MenuItem（押せない項目の理由）', () => {
  it('押せない項目は、理由を項目名の下に常に出す（title だけに頼らない）', () => {
    const btn = renderItem({ disabled: true, reason: '添付のフォルダは動かせません' });
    expect(btn.disabled).toBe(true);
    const reason = btn.querySelector('.menu-item-reason');
    expect(reason?.textContent).toBe('添付のフォルダは動かせません');
    // 項目名の後に理由（同じ項目の中で、名前の下）
    expect(btn.querySelector('.label-text')?.nextElementSibling).toBe(reason);
    expect(btn.textContent).toContain('名前を変更');
  });

  it('理由の文字は補足の大きさ・--text-muted（ダークモードでも読める色トークン）。色を直書きしない', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('src/components/ui/MenuItem.svelte', 'utf8').split('<style>')[1] ?? '';
    const rule = css.match(/\.menu-item-reason\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('var(--text-muted)');
    expect(rule).toContain('var(--fs-xs)');
    expect(rule).not.toMatch(/#[0-9a-f]{3,6}|rgb\(/i);
  });

  it('押せる項目には理由を出さない（項目名だけ）', () => {
    const btn = renderItem({ reason: '理由があっても、押せるなら出さない' });
    expect(btn.disabled).toBe(false);
    expect(btn.querySelector('.menu-item-reason')).toBeNull();
    expect(btn.textContent?.trim()).toBe('名前を変更');
  });

  it('押せない項目は押しても動かない', () => {
    const onclick = vi.fn();
    const btn = renderItem({ disabled: true, reason: '理由', onclick });
    btn.click();
    expect(onclick).not.toHaveBeenCalled();
  });

  it('理由を渡さない押せない項目は、理由の行を出さない', () => {
    const btn = renderItem({ disabled: true });
    expect(btn.disabled).toBe(true);
    expect(btn.querySelector('.menu-item-reason')).toBeNull();
  });
});
