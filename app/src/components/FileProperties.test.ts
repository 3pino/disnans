// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import FileProperties from './FileProperties.svelte';
import type { SharedEntry } from '../lib/protocol/SharedEntry';

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

describe('プロパティ（読むだけ）', () => {
  it('名前・パス・種類（MIME）・サイズ・更新日時を出す。作成日時は出さない（サーバーが持たない）', () => {
    const text = open(base);
    expect(text).toContain('docs/a.txt');
    expect(text).toContain('TXT');
    expect(text).toContain('text/plain');
    expect(text).toContain('2.0 KB');
    expect(text).not.toContain('作成日時');
  });

  it('フォルダは「フォルダ」、サイズは出さない（種類と同じ文言）', () => {
    const text = open({ ...base, name: 'docs', path: 'docs', kind: 'dir', size: 0, mime: null, modified: 0 });
    expect(text).toContain('フォルダ');
    expect(text).toContain('—');
  });

  it('添付の ID・投稿されたメッセージは出さない', () => {
    const text = open({ ...base, path: 'attachments/a.txt', file_id: 'F1', message_id: 'M1' });
    expect(text).not.toContain('F1');
    expect(text).not.toContain('M1');
    expect(text).not.toContain('添付の ID');
  });

  it('名前・パスを押すとコピーする（サイズ・更新日時は押せない）', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    open(base);
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.file-properties-copy')];
    expect(buttons.map((b) => b.textContent)).toEqual(['a.txt', 'docs/a.txt']);
    buttons[1].click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('docs/a.txt'));
  });

  it('見出し（名前・パスなど）は選べない', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/components/FileProperties.svelte', 'utf8');
    expect(src).toMatch(/\.file-properties dt \{[^}]*user-select: none/);
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
