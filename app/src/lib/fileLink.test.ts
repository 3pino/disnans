import { describe, expect, it } from 'vitest';
import { attachmentActionText, attachmentNameError, deletedAttachmentNames, fileLinkView, isImage, isPdf } from './fileLink';
import { HttpError } from './transport/http';
import type { SharedEntry } from './protocol/SharedEntry';
import type { Message } from './protocol/Message';
import type { FileState } from './stores/sharedIndex.svelte';

const entry = (over: Partial<SharedEntry> & { name: string; path: string }): SharedEntry => ({
  kind: 'file',
  size: 2048,
  modified: 0,
  mime: null,
  message_id: null,
  file_id: null,
  ...over,
});

const found = (e: SharedEntry): FileState => ({ kind: 'found', entry: e });
const none = new Set<string>();

describe('isImage', () => {
  it('mime があればそれで、なければ拡張子で見る', () => {
    expect(isImage('a.bin', 'image/png')).toBe(true);
    expect(isImage('a.png', 'application/octet-stream')).toBe(false);
    expect(isImage('photo.JPG')).toBe(true);
    expect(isImage('doc.pdf', null)).toBe(false);
  });
});

describe('fileLinkView（リンク）', () => {
  it('ファイルはリンク（別名があれば別名。クリックで開く・保存する）', () => {
    const e = entry({ name: 'a.pdf', path: 'docs/a.pdf' });
    const v = fileLinkView({ path: 'docs/a.pdf', alias: '資料', embed: false }, found(e), none);
    expect(v).toMatchObject({ kind: 'link', name: 'a.pdf', text: '資料' });
    expect((v as { href: string }).href).toContain('/api/shared/docs/a.pdf');
  });

  it('別名が無ければ名前、画像は拡大表示のボタン', () => {
    const e = entry({ name: 'photo.png', path: 'attachments/photo.png', mime: 'image/png', file_id: 'F1' });
    const v = fileLinkView({ path: 'attachments/photo.png', alias: null, embed: false }, found(e), none);
    expect(v).toMatchObject({ kind: 'image', text: 'photo.png', src: expect.stringContaining('/api/files/F1') });
  });

  it('画像で ID が無ければ共有フォルダのパスを使う', () => {
    const e = entry({ name: 'p.jpg', path: 'docs/p.jpg' });
    const v = fileLinkView({ path: 'docs/p.jpg', alias: 'x', embed: false }, found(e), none);
    expect(v).toMatchObject({ kind: 'image', src: expect.stringContaining('/api/shared/docs/p.jpg') });
  });

  it('フォルダはリンクにしない', () => {
    const e = entry({ name: 'docs', path: 'docs', kind: 'dir' });
    expect(fileLinkView({ path: 'docs', alias: null, embed: false }, found(e), none)).toEqual({ kind: 'folder', name: 'docs', text: 'docs' });
  });
});

describe('fileLinkView（埋め込み）', () => {
  it('画像は埋め込みの画像（ID の URL）', () => {
    const e = entry({ name: 'p.png', path: 'attachments/p.png', mime: 'image/png', file_id: 'F9' });
    const v = fileLinkView({ path: 'attachments/p.png', alias: null, embed: true }, found(e), none);
    expect(v).toMatchObject({ kind: 'embedImage', alt: 'p.png', src: expect.stringContaining('/api/files/F9') });
  });

  it('画像以外はファイルのカード', () => {
    const e = entry({ name: 'a.zip', path: 'attachments/a.zip', mime: 'application/zip', size: 5, file_id: 'F2' });
    const v = fileLinkView({ path: 'attachments/a.zip', alias: null, embed: true }, found(e), none);
    expect(v).toMatchObject({ kind: 'embedFile', name: 'a.zip', size: 5 });
  });
});

describe('fileLinkView（見つからない・削除・確かめ中）', () => {
  it('確かめ中は pending（別名のまま）', () => {
    expect(fileLinkView({ path: 'docs/a', alias: '表', embed: false }, { kind: 'loading' }, none)).toEqual({ kind: 'pending', text: '表' });
  });

  it('一覧に無ければ missing（404 も error も同じ扱い）', () => {
    expect(fileLinkView({ path: 'docs/x', alias: null, embed: false }, { kind: 'missing' }, none)).toMatchObject({ kind: 'missing' });
    expect(fileLinkView({ path: 'docs/x', alias: null, embed: true }, { kind: 'error', message: 'x' }, none)).toMatchObject({ kind: 'missing' });
  });

  it('同じ名前の削除された添付があれば deleted（attachments/ だけ）', () => {
    const del = new Set(['photo.png']);
    expect(fileLinkView({ path: 'attachments/photo.png', alias: null, embed: false }, { kind: 'missing' }, del)).toEqual({
      kind: 'deleted',
      name: 'photo.png',
    });
    // 共有フォルダの別のパスは、添付の削除とは関係ない
    expect(fileLinkView({ path: 'docs/photo.png', alias: null, embed: false }, { kind: 'missing' }, del)).toMatchObject({ kind: 'missing' });
  });

  it('今ある項目が、削除された添付と同じ名前なら今あるものを出す', () => {
    const e = entry({ name: 'photo.png', path: 'attachments/photo.png', mime: 'image/png', file_id: 'F3' });
    const v = fileLinkView({ path: 'attachments/photo.png', alias: null, embed: false }, found(e), new Set(['photo.png']));
    expect(v.kind).toBe('image');
  });
});

describe('deletedAttachmentNames', () => {
  it('削除された添付の名前（小文字で）を集める', () => {
    const msgs = [
      { id: '1', attachments: [{ file_name: 'A.png', deleted: true }, { file_name: 'b.txt', deleted: false }] },
      { id: '2', attachments: [] },
    ] as unknown as Message[];
    expect([...deletedAttachmentNames(msgs)]).toEqual(['a.png']);
  });
});

describe('添付の名前の変更', () => {
  it('空・区切り・リンクの記号・改行は使えない', () => {
    expect(attachmentNameError('  ')).toBe('名前を入力してください');
    for (const bad of ['a/b', 'a\\b', 'x[1]', 'x|y', 'a\nb']) expect(attachmentNameError(bad), bad).not.toBeNull();
    expect(attachmentNameError('写真 (2).png')).toBeNull();
    expect(attachmentNameError('写真.png')).toBeNull();
  });

  it('失敗の文は、サーバーの code があればその文言、なければサーバーの文', () => {
    expect(attachmentActionText(new HttpError(400, 'invalid_link', 'x'))).toContain('リンク先のファイル');
    expect(attachmentActionText(new HttpError(409, 'exists', '同じ名前の添付があります'))).toBe('同じ名前の添付があります');
    expect(attachmentActionText(new HttpError(403, 'forbidden', '名前が使えません'))).toBe('名前が使えません');
    expect(attachmentActionText(new Error('他'))).toBe('他');
  });

  it('送信の invalid_link は、リンクを直すよう伝える文', async () => {
    const { errorText } = await import('./errors');
    expect(errorText('invalid_link', 'x')).toContain('リンク先のファイル');
  });
});

describe('PDF の見分け', () => {
  it('mime があればそれ、無い・汎用なら拡張子で見る', () => {
    expect(isPdf('a.bin', 'application/pdf')).toBe(true);
    expect(isPdf('a.pdf', 'text/plain')).toBe(false);
    expect(isPdf('A.PDF', null)).toBe(true);
    expect(isPdf('a.pdf', 'application/octet-stream')).toBe(true);
    expect(isPdf('a.txt')).toBe(false);
  });
});
