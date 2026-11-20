// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import MessageInput from './MessageInput.svelte';

// 添付パネルを開いたとき、本文の入力欄のフォーカスを外す（blur）。本文（下書き）は消さない
let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;
afterEach(async () => {
  if (instance) await unmount(instance);
  target?.remove();
  instance = undefined;
  target = undefined;
});

async function renderInput(initial: string): Promise<{ ta: HTMLTextAreaElement; api: { blur(): void; focus(): void } }> {
  target = document.createElement('div');
  document.body.append(target);
  let api: { blur(): void; focus(): void } | undefined;
  instance = mount(MessageInput, { target, props: { initial, placeholder: '' } });
  flushSync();
  await tick();
  api = instance as unknown as { blur(): void; focus(): void };
  return { ta: target.querySelector('textarea')!, api };
}

describe('MessageInput.blur', () => {
  it('フォーカスを外すが、本文は消さない', async () => {
    const { ta, api } = await renderInput('書きかけ');
    ta.focus();
    expect(document.activeElement).toBe(ta);
    api.blur();
    expect(document.activeElement).not.toBe(ta);
    expect(ta.value).toBe('書きかけ');
  });
});
