import { describe, expect, it } from 'vitest';
import { attachmentsToText, attachmentRefs, bodyAttachmentNames } from './fileLink';

// 本文の添付のリンク（サーバーが名前に戻したあとの形: attachments/<今の名前>）
describe('本文の添付のリンク', () => {
  it('埋め込み・リンク・別名つきの書き方を、すべて名前として拾う', () => {
    const body = '![[attachments/a.png]] [資料](attachments/doc.pdf) ![絵](attachments/b.jpg) [[attachments/c.zip|別名]]';
    expect([...bodyAttachmentNames(body)]).toEqual(['a.png', 'doc.pdf', 'b.jpg', 'c.zip']);
    expect(attachmentRefs(body).map((r) => [r.name, r.embed, r.alias])).toEqual([
      ['a.png', true, null],
      ['doc.pdf', false, '資料'],
      ['b.jpg', true, '絵'],
      ['c.zip', false, '別名'],
    ]);
  });

  it('名前に括弧を含んでも（「name (2).png」）最後の対の ) まで読む', () => {
    const body = '![絵](attachments/name (2).png) と続く';
    expect([...bodyAttachmentNames(body)]).toEqual(['name (2).png']);
  });

  it('名前は大文字小文字を区別せず、フォルダの外のパスは拾わない', () => {
    const body = '![[attachments/A.PNG]] [x](docs/a.png) ![[docs/b.png]]';
    expect([...bodyAttachmentNames(body)]).toEqual(['a.png']);
  });

  it('閉じていないリンクは拾わない（本文の文字として残る）', () => {
    expect([...bodyAttachmentNames('[x](attachments/a.png')]).toEqual([]);
    expect(attachmentRefs('[x](attachments/a.png\n次の行)')).toEqual([]);
  });

  it('返信先などの文字: 埋め込みの画像は「画像」、そのほかは別名か名前', () => {
    expect(attachmentsToText('![[attachments/a.png]]')).toBe('画像');
    expect(attachmentsToText('![[attachments/doc.pdf]]')).toBe('doc.pdf');
    expect(attachmentsToText('[資料](attachments/doc.pdf) を見て')).toBe('資料 を見て');
    expect(attachmentsToText('![[disnans:file/abc]] 写真')).toBe('添付 写真');
    expect(attachmentsToText('普通の文 [x](https://example.com)')).toBe('普通の文 [x](https://example.com)');
  });
});
