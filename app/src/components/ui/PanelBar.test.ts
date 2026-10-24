// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRawSnippet, flushSync, mount, unmount } from 'svelte';
import PanelBar from './PanelBar.svelte';

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;
afterEach(async () => {
  if (instance) await unmount(instance);
  target?.remove();
  instance = undefined;
});

const snip = (html: string) => createRawSnippet(() => ({ render: () => html }));

function render(props: Record<string, unknown> = {}) {
  target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(PanelBar, { target, props: { children: snip('<span class="t">題名</span>'), ...props } });
  flushSync();
  return target.querySelector<HTMLElement>('header')!;
}

describe('PanelBar', () => {
  it('上の安全域は .top-bar の 1 か所。題名は main の中', () => {
    const bar = render();
    expect(bar.classList.contains('top-bar')).toBe(true);
    expect(bar.querySelector('.panel-bar-main .t')?.textContent).toBe('題名');
    expect(bar.querySelector('button')).toBeNull();
  });

  it('onback があれば戻るボタンが先頭に出て、押すと呼ばれる', () => {
    const onback = vi.fn();
    const bar = render({ onback });
    const btn = bar.firstElementChild as HTMLButtonElement;
    expect(btn.getAttribute('aria-label')).toBe('戻る');
    expect(bar.classList.contains('panel-bar-has-back')).toBe(true);
    btn.click();
    expect(onback).toHaveBeenCalledOnce();
  });

  it('右の操作は main のあとに並ぶ', () => {
    const bar = render({ actions: snip('<button class="a">操作</button>') });
    expect(bar.lastElementChild?.className).toContain('a');
    expect(bar.querySelector('.panel-bar-main')?.nextElementSibling).toBe(bar.lastElementChild);
  });
});
