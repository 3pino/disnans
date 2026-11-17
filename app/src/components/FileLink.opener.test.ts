// @vitest-environment jsdom
// 本文のファイルリンクの「開く」: プラグインが口を登録していれば、そちらへ。無ければ本体の既定（保存）のまま
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { SharedEntry } from '../lib/protocol/SharedEntry';
import type { Block, Inline } from '../lib/markdown';
import { sharedIndex } from '../lib/stores/sharedIndex.svelte';
import { setLinkOpener } from '../lib/linkOpener.svelte';

const list = vi.fn(async (dir: string): Promise<SharedEntry[]> =>
  dir === ''
    ? [{ name: 'a.txt', path: 'a.txt', kind: 'file', size: 3, modified: 0, mime: 'text/plain', message_id: null, file_id: null }]
    : [],
);
vi.mock('../lib/transport/shared', () => ({ sharedApi: { list: (dir: string) => list(dir) } }));

const { default: Markdown } = await import('./Markdown.svelte');

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;
beforeEach(() => {
  target = document.createElement('div');
  document.body.appendChild(target);
});
afterEach(async () => {
  if (instance) await unmount(instance);
  instance = undefined;
  target?.remove();
  target = undefined;
});

const link: Inline = { type: 'fileLink', path: 'a.txt', alias: '資料', embed: false };
const tree: Block[] = [{ type: 'paragraph', lines: [[link]] }];

async function render(): Promise<HTMLAnchorElement> {
  instance = mount(Markdown, { target: target!, props: { body: '', markdown: tree } });
  flushSync();
  await vi.waitFor(() => {
    if (sharedIndex.file('a.txt').kind !== 'found') throw new Error('not loaded');
  });
  await tick();
  flushSync();
  const a = target!.querySelector<HTMLAnchorElement>('a.file-link');
  if (!a) throw new Error('no link rendered');
  return a;
}

describe('本文のファイルリンクの「開く」（プラグインの口）', () => {
  it('口が無ければ、いつもどおり（押しは既定の動き。口は呼ばない）', async () => {
    const a = await render();
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    a.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('口があれば、押しを止めて、パスと別名を渡す。外すと既定に戻る', async () => {
    const opener = vi.fn();
    const off = setLinkOpener(opener);
    const a = await render();
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    a.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(opener).toHaveBeenCalledWith('a.txt', '資料');
    off();
    const ev2 = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    a.dispatchEvent(ev2);
    expect(ev2.defaultPrevented).toBe(false);
    expect(opener).toHaveBeenCalledTimes(1);
  });
});
