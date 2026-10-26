import { describe, expect, it } from 'vitest';
import type { Attachment } from './protocol/Attachment';
import type { Message } from './protocol/Message';
import { adjacentItem, chatImageItems, type LightboxItem } from './lightbox';
import { fileUrl } from './config';
import { attachmentRefs } from './fileLink';

function msg(id: string, body: string, attachments: Partial<Attachment>[] = []): Message {
  return {
    id,
    author_id: 'u',
    reply_to: null,
    reply_preview: null,
    body,
    attachments: attachments.map((a, i) => ({
      id: `${id}-f${i}`,
      file_name: 'x.png',
      mime: 'image/png',
      size: 1,
      has_thumb: false,
      width: null,
      height: null,
      deleted: false,
      ...a,
    })) as Attachment[],
    reactions: [],
    created_at: 0,
    edited_at: null,
    card: null,
    bot: null,
  } as Message;
}

/** 本文の画像リンク（テスト用）: 名前から、画像として出す項目を作る */
function bodyImage(ref: { name: string; alias: string | null }): LightboxItem | null {
  if (!/\.(png|jpe?g)$/i.test(ref.name)) return null;
  const src = `/shared/attachments/${ref.name}`;
  return { src, alt: ref.alias ?? ref.name, downloadUrl: src };
}

describe('チャットの画像の一覧（順序・本文と添付・画像以外を除く）', () => {
  it('メッセージの並び順（古い→新しい）。1 メッセージの中は、本文の出現順のあとに本文に無い添付', () => {
    const messages = [
      msg('m1', '![[attachments/a.png]] と ![[attachments/b.png]]'),
      msg('m2', '', [{ file_name: 'c.png' }]),
      msg('m3', '[[attachments/d.jpg]]'),
    ];
    const items = chatImageItems(messages, bodyImage);
    expect(items.map((i) => i.alt)).toEqual(['a.png', 'b.png', 'c.png', 'd.jpg']);
  });

  it('1 メッセージの中: 本文の画像（出現順）→ 本文に無い添付の画像（一覧の順）', () => {
    const messages = [msg('m1', '![[attachments/z.png]]', [{ file_name: 'free1.png' }, { file_name: 'free2.png' }])];
    expect(chatImageItems(messages, bodyImage).map((i) => i.alt)).toEqual(['z.png', 'free1.png', 'free2.png']);
  });

  it('本文に入っている添付は、本文の側で数える（二重に数えない）', () => {
    const messages = [msg('m1', '![[attachments/a.png]]', [{ file_name: 'a.png' }])];
    expect(chatImageItems(messages, bodyImage)).toHaveLength(1);
  });

  it('削除された添付と、画像でない添付（ファイル・PDF）は含めない', () => {
    const messages = [
      msg('m1', '', [
        { file_name: 'gone.png', deleted: true },
        { file_name: 'doc.pdf', mime: 'application/pdf' },
        { file_name: 'ok.png' },
      ]),
    ];
    expect(chatImageItems(messages, bodyImage).map((i) => i.alt)).toEqual(['ok.png']);
  });

  it('本文の画像は bodyImage が決める（null の参照は含めない。PDF や未解決のもの）', () => {
    const messages = [msg('m1', '[[attachments/a.pdf]] [[attachments/b.png]]')];
    expect(chatImageItems(messages, bodyImage).map((i) => i.alt)).toEqual(['b.png']);
  });

  it('添付の画像の src は、ファイルの URL（fileUrl）と同じ', () => {
    const messages = [msg('m1', '', [{ id: 'file-9', file_name: 'p.png' }])];
    expect(chatImageItems(messages, bodyImage)[0]).toEqual({ src: fileUrl('file-9'), alt: 'p.png', downloadUrl: fileUrl('file-9') });
  });

  it('本文の参照の解析は attachmentRefs の結果（埋め込みとリンクの両方、出現順）', () => {
    const refs = attachmentRefs('[[attachments/a.png|別名]] ![x](attachments/b.png)');
    expect(refs.map((r) => r.name)).toEqual(['a.png', 'b.png']);
  });
});

describe('前後の画像（端では動かさない）', () => {
  const items: LightboxItem[] = ['a', 'b', 'c'].map((n) => ({ src: `${n}.png`, alt: n, downloadUrl: `${n}.png` }));

  it('前後へ移る。端（最初の前・最後の次）と、一覧にない画像は null', () => {
    expect(adjacentItem(items, 'b.png', -1)?.src).toBe('a.png');
    expect(adjacentItem(items, 'b.png', 1)?.src).toBe('c.png');
    expect(adjacentItem(items, 'a.png', -1)).toBeNull();
    expect(adjacentItem(items, 'c.png', 1)).toBeNull();
    expect(adjacentItem(items, 'zz.png', 1)).toBeNull();
  });

  it('一覧が空なら前後は無い', () => {
    expect(adjacentItem([], 'a.png', 1)).toBeNull();
  });
});
