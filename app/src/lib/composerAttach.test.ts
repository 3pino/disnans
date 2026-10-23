import { describe, expect, it } from 'vitest';
import { embedFor, insertAt, replaceFirst } from './composerAttach';
import { bodyToDraft, draftToBody } from './mentions';

describe('入力欄の添付の埋め込み', () => {
  it('アップロードの名前を、本文の添付の書き方にする', () => {
    expect(embedFor('photo (2).png')).toBe('![[attachments/photo (2).png]]');
  });

  it('キャレットの位置に入れ、前が文字なら空白を 1 つ足す', () => {
    expect(insertAt('見て', 2, '![[attachments/a.png]]')).toEqual({ text: '見て ![[attachments/a.png]]', caret: 2 + 1 + 22 });
    expect(insertAt('見て ', 3, 'X')).toEqual({ text: '見て X', caret: 4 });
    expect(insertAt('', 0, 'X')).toEqual({ text: 'X', caret: 1 });
  });

  it('キャレットが途中なら、その位置に入れて後ろはそのまま', () => {
    const r = insertAt('ab\ncd', 2, 'X');
    expect(r.text).toBe('ab X\ncd');
    expect(r.caret).toBe(4);
  });

  it('キャレットが範囲の外なら末尾', () => {
    expect(insertAt('abc', 99, 'X').text).toBe('abc X');
    expect(insertAt('abc', -5, 'X').text).toBe('Xabc');
  });

  it('本文の中の埋め込みを置き換える。無ければ null', () => {
    const body = 'a ![[attachments/a.png]] b';
    expect(replaceFirst(body, '![[attachments/a.png]]', '![[attachments/a (2).png]]')?.text).toBe('a ![[attachments/a (2).png]] b');
    expect(replaceFirst(body, '![[attachments/zz.png]]', 'x')).toBeNull();
  });
});

// 編集欄: 埋め込みを含む本文をそのまま出す（写真のみの旧メッセージも空欄にならない）
describe('編集欄の本文の埋め込み', () => {
  it('埋め込みだけの本文は、そのまま編集欄に出て、保存しても同じ本文になる', () => {
    const body = '![[attachments/photo (2).png]]';
    const map = new Map<string, string>();
    const draft = bodyToDraft(body, {}, map);
    expect(draft).toBe(body);
    expect(draftToBody(draft, map)).toBe(body);
    expect(draft.trim()).not.toBe('');
  });
});
