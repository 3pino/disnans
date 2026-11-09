// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Timeline } from './timeline.svelte';
import type { Message } from '../protocol/Message';
import type { Block } from '../markdown';

const tree: Block[] = [{ type: 'paragraph', lines: [[{ type: 'link', href: 'https://example.com', text: 'https://example.com' }]] }];
const msg = (over: Partial<Message> & { markdown?: Block[] } = {}): Message =>
  ({ id: 'm1', author_id: 'u1', reply_to: null, reply_preview: null, body: 'https://example.com', attachments: [], reactions: [], created_at: 1, edited_at: null, card: null, bot: null, ...over }) as Message;

function loaded(): Timeline {
  const t = new Timeline();
  t.loaded = true;
  return t;
}

describe('upsert と構文木（送信直後のリンク・埋め込み）', () => {
  it('木のある echo のあとに、木の無い確定の結果が来ても、木を残す', () => {
    const t = loaded();
    t.upsert(msg({ markdown: tree } as never));
    t.upsert(msg());
    expect((t.messages[0] as { markdown?: Block[] }).markdown).toEqual(tree);
  });
  it('本文が違う（編集された）ときは、古い木を引き継がない', () => {
    const t = loaded();
    t.upsert(msg({ markdown: tree } as never));
    t.upsert(msg({ body: 'changed' }));
    expect((t.messages[0] as { markdown?: Block[] }).markdown).toBeUndefined();
  });
  it('新しい木があるときは、新しい木を使う', () => {
    const t = loaded();
    const other: Block[] = [{ type: 'paragraph', lines: [[{ type: 'text', text: 'x' }]] }];
    t.upsert(msg({ markdown: tree } as never));
    t.upsert(msg({ markdown: other } as never));
    expect((t.messages[0] as { markdown?: Block[] }).markdown).toEqual(other);
  });
});
