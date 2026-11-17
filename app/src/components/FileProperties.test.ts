// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import FileProperties from './FileProperties.svelte';
import type { SharedEntry } from '../lib/protocol/SharedEntry';

const { mockSize } = vi.hoisted(() => ({
  mockSize: vi.fn(async () => ({ size: 12345, files: 3, dirs: 1 })),
}));

vi.mock('../lib/transport/shared', () => ({
  sharedApi: {
    size: mockSize,
    trash: vi.fn(),
    restore: vi.fn(),
    trashList: vi.fn(async () => []),
    purge: vi.fn(),
  },
}));

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;
afterEach(async () => {
  if (instance) await unmount(instance);
  target?.remove();
  instance = undefined;
  target = undefined;
});

const base: SharedEntry = { name: 'a.txt', path: 'docs/a.txt', kind: 'file', size: 2048, modified: 1_700_000_000_000, mime: 'text/plain', message_id: null, file_id: null };

function open(entry: SharedEntry): string {
  target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(FileProperties, { target, props: { entry, onclose: () => {} } });
  flushSync();
  return document.body.textContent ?? '';
}

// 画面の流れは共有の部品（@3pino/explorer-kit の FileProperties.screen.test.ts）が試験する。ここは、Disnans の置き場所（sharedApi）・本体の機能（メッセージ検索）へつながっていることだけ
describe('プロパティ（Disnans の置き場所・本体へのつながり）', () => {
  it('フォルダは計算中になり、サイズ取得後は件数を出す', async () => {
    open({ ...base, name: 'docs', path: 'docs', kind: 'dir', size: 0, mime: null, modified: 0 });
    // 最初は計算中
    expect(document.body.textContent).toContain('計算中');
    // size が返ったあとはバイト数と件数を出す
    await vi.waitFor(() => expect(document.body.textContent).toContain('12,345'));
    expect(document.body.textContent).toContain('3 ファイル');
  });

  it('「メッセージを検索」で、ファイルの名前で検索を始める（フォルダには出さない）', async () => {
    const { ui } = await import('../lib/stores/ui.svelte');
    const { messageSearch } = await import('../lib/stores/search.svelte');
    const onclose = vi.fn();
    target = document.createElement('div');
    document.body.appendChild(target);
    instance = mount(FileProperties, { target, props: { entry: base, onclose } });
    flushSync();
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('メッセージを検索'))!;
    btn.click();
    expect(onclose).toHaveBeenCalled();
    expect(ui.searchOpen).toBe(true);
    expect(messageSearch.query).toBe('a.txt');
    messageSearch.setQuery('');
    ui.searchOpen = false;
  });

  it('フォルダには「メッセージを検索」を出さない', () => {
    const text = open({ ...base, name: 'docs', path: 'docs', kind: 'dir', size: 0, mime: null });
    expect(text).not.toContain('メッセージを検索');
  });
});
