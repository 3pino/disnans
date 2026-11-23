// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { SharedEntry } from '../lib/protocol/SharedEntry';
import type { Block, Inline } from '../lib/markdown';
import { sharedIndex } from '../lib/stores/sharedIndex.svelte';

// 取りこぼした files.changed で「attachments」の一覧の写しが古いままでも、「見つからない」と出た項目が一度だけ読み直して直る
let present = false;
const entry = (): SharedEntry => ({ name: 'p.webp', path: 'attachments/p.webp', kind: 'file', size: 3, modified: 0, mime: 'image/webp', message_id: 'm1', file_id: 'F1' });
const list = vi.fn(async (dir: string): Promise<SharedEntry[]> => (dir === 'attachments' && present ? [entry()] : []));
vi.mock('../lib/transport/shared', () => ({ sharedApi: { list: (dir: string) => list(dir) } }));

const { default: Markdown } = await import('./Markdown.svelte');

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;
beforeEach(() => {
  present = false;
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

const embed: Inline = { type: 'fileLink', path: 'attachments/p.webp', alias: null, embed: true };
const tree: Block[] = [{ type: 'paragraph', lines: [[embed]] }];

describe('「見つからない」の読み直し', () => {
  it('写しが古くて無いと出ても、一度読み直して、あれば直る', async () => {
    // 古い写し: 一覧は読めたが、まだファイルが無かった
    sharedIndex.ensure('attachments');
    await vi.waitFor(() => expect(sharedIndex.state('attachments')?.kind).toBe('ok'));
    present = true; // その後にファイルが入ったが、files.changed は届かなかった
    instance = mount(Markdown, { target: target!, props: { body: '', markdown: tree } });
    flushSync();
    await vi.waitFor(() => expect(sharedIndex.file('attachments/p.webp').kind).toBe('found'));
    await tick();
    flushSync();
    expect(target!.querySelector('.file-link-missing')).toBeNull();
    expect(target!.querySelector('.file-link-embed-image')).not.toBeNull();
  });

  it('読み直してもなければ、本当に無い（読み続けない）', async () => {
    instance = mount(Markdown, { target: target!, props: { body: '', markdown: tree } });
    flushSync();
    await vi.waitFor(() => expect(target!.querySelector('.file-link-missing')).not.toBeNull());
    await new Promise((r) => setTimeout(r, 300));
    const n = list.mock.calls.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(list.mock.calls.length).toBe(n);
    expect(n).toBeLessThanOrEqual(3);
  });
});
