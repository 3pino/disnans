// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { SharedEntry } from '../lib/protocol/SharedEntry';
import type { Block, Inline } from '../lib/markdown';
import { sharedIndex } from '../lib/stores/sharedIndex.svelte';

// 「読み込めませんでした」の横の「再読み込み」: 押すと一覧を読み直し、読めれば表示が直る
let fail = true;
const entry: SharedEntry = { name: 'a.txt', path: 'docs/a.txt', kind: 'file', size: 3, modified: 0, mime: 'text/plain', message_id: null, file_id: null };
const list = vi.fn(async (): Promise<SharedEntry[]> => {
  if (fail) throw new Error('offline');
  return [entry];
});
vi.mock('../lib/transport/shared', () => ({ sharedApi: { list: () => list() } }));

const { default: Markdown } = await import('./Markdown.svelte');

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;
beforeEach(() => {
  fail = true;
  list.mockClear();
  sharedIndex.clear();
  target = document.createElement('div');
  document.body.appendChild(target);
});
afterEach(async () => {
  if (instance) await unmount(instance);
  instance = undefined;
  target?.remove();
  target = undefined;
});

const link: Inline = { type: 'fileLink', path: 'docs/a.txt', alias: null, embed: false };
const tree: Block[] = [{ type: 'paragraph', lines: [[link]] }];

describe('読み込めなかったファイルリンクの「再読み込み」', () => {
  it('押すと読み直し、読めれば、リンクに直る', async () => {
    instance = mount(Markdown, { target: target!, props: { body: '', markdown: tree } });
    flushSync();
    await vi.waitFor(() => expect(target!.textContent).toContain('読み込めませんでした（a.txt）'));
    const button = target!.querySelector<HTMLButtonElement>('.file-link-reload');
    expect(button?.getAttribute('aria-label')).toBe('再読み込み');
    expect(button?.textContent?.trim()).toBe('');
    fail = false;
    button!.click();
    await vi.waitFor(() => expect(target!.querySelector('a.file-link')).not.toBeNull());
    await tick();
    expect(target!.querySelector('.file-link-reload')).toBeNull();
  });
});
