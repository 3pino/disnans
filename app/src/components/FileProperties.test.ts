// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
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

  it('添付は ID と投稿されたメッセージを出す。投稿前は「まだ投稿されていません」', () => {
    const unposted = open({ ...base, path: 'attachments/a.txt', file_id: 'F1', message_id: null });
    expect(unposted).toContain('F1');
    expect(unposted).toContain('まだ投稿されていません');
  });
});
