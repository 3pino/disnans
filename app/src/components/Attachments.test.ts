// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import Attachments from './Attachments.svelte';
import type { Attachment } from '../lib/protocol/Attachment';

// 本文に埋め込まれた添付は、別枠に出さない（本文の中で出す）。本文に無い添付だけ別枠に出す
let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;
afterEach(async () => {
  if (instance) await unmount(instance);
  target?.remove();
  instance = undefined;
  target = undefined;
});

const att = (id: string, name: string, mime: string, over: Partial<Attachment> = {}): Attachment => ({
  id,
  file_name: name,
  mime,
  size: 10,
  width: mime.startsWith('image/') ? 10 : null,
  height: mime.startsWith('image/') ? 10 : null,
  has_thumb: false,
  deleted: false,
  ...over,
});

function render(attachments: Attachment[], body: string): HTMLElement {
  target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(Attachments, { target, props: { attachments, body } });
  flushSync();
  return target;
}

describe('添付の別枠', () => {
  it('本文に埋め込まれている添付は、別枠に出さない', () => {
    const el = render([att('1', 'a.png', 'image/png'), att('2', 'doc.pdf', 'application/pdf')], '![[attachments/a.png]] ![[attachments/doc.pdf]]');
    expect(el.querySelector('.attachment-image')).toBeNull();
    expect(el.querySelector('.attachment-file')).toBeNull();
  });

  it('本文に無い添付（送信の途中など）は別枠に出す。本文にあるものは出さない', () => {
    const el = render([att('1', 'a.png', 'image/png'), att('2', 'doc.pdf', 'application/pdf')], '![[attachments/a.png]]');
    expect(el.querySelectorAll('.attachment-image')).toHaveLength(0);
    expect(el.querySelectorAll('.attachment-file')).toHaveLength(1);
    expect(el.textContent).toContain('doc.pdf');
  });

  it('削除された添付も、本文に残っていれば別枠に出さない（本文の中で「削除されたファイル」と出す）', () => {
    const el = render([att('1', 'old.pdf', 'application/pdf', { deleted: true })], '![[attachments/old.pdf]]');
    expect(el.querySelector('.attachment-file-deleted')).toBeNull();
  });

  it('本文の中でも、別枠でも、添付に「…」（名前の変更・削除）は付けない。操作はエクスプローラーで行う', () => {
    const el = render([att('1', 'a.png', 'image/png'), att('2', 'doc.pdf', 'application/pdf')], '');
    expect(el.querySelector('.shared-entry-menu-button')).toBeNull();
    expect(el.querySelectorAll('button').length).toBe(1);
  });
});
