// @vitest-environment jsdom
// 行の中の部品（InlineNodes）: 上付き・下付き（sub / sup）と、HTML の文字列を作らないこと（文字はテキストとして出る）
import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';
import InlineNodes from './InlineNodes.svelte';
import type { Inline } from '../lib/markdown';

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;
afterEach(async () => {
  if (instance) await unmount(instance);
  target?.remove();
  instance = undefined;
  target = undefined;
});

function render(nodes: Inline[]): HTMLElement {
  target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(InlineNodes as unknown as Component<Record<string, unknown>>, { target, props: { nodes } });
  flushSync();
  return target;
}

describe('上付き・下付き（sub / sup）', () => {
  it('sub は <sub> の要素になり、中身を持つ（前後の文字はそのまま）', () => {
    const el = render([
      { type: 'text', text: 'H' },
      { type: 'sub', children: [{ type: 'text', text: '2' }] },
      { type: 'text', text: 'O' },
    ]);
    expect(el.textContent).toBe('H2O');
    const sub = el.querySelector('sub');
    expect(sub?.textContent).toBe('2');
    expect(el.querySelector('sup')).toBeNull();
  });

  it('sup は <sup> の要素になり、中の強調も描く', () => {
    const el = render([{ type: 'sup', children: [{ type: 'bold', children: [{ type: 'text', text: 'n' }] }] }]);
    const sup = el.querySelector('sup');
    expect(sup?.textContent).toBe('n');
    expect(sup?.querySelector('strong')?.textContent).toBe('n');
  });

  it('sub の中の sup も、入れ子の要素として描く', () => {
    const el = render([{ type: 'sub', children: [{ type: 'sup', children: [{ type: 'text', text: 'x' }] }] }]);
    expect(el.querySelector('sub > sup')?.textContent).toBe('x');
  });
});

describe('生の HTML を作らない', () => {
  it('木の文字に <b> の形があっても、文字としてそのまま出る（タグとして解釈しない）', () => {
    const el = render([{ type: 'text', text: '<b>x</b>' }]);
    expect(el.querySelector('b')).toBeNull();
    expect(el.textContent).toBe('<b>x</b>');
  });
});
