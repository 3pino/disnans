import { describe, expect, it } from 'vitest';
import { searchTerms, snippetSegments } from './search';

describe('searchTerms', () => {
  it('空白で区切り、空の語は除く', () => {
    expect(searchTerms('  会議  資料 ')).toEqual(['会議', '資料']);
    expect(searchTerms('   ')).toEqual([]);
  });
});

describe('snippetSegments', () => {
  it('一致の部分を hit にする（大文字・小文字は区別しない）', () => {
    expect(snippetSegments('Hello World', 'world')).toEqual([
      { text: 'Hello ', hit: false },
      { text: 'World', hit: true },
    ]);
  });

  it('語が複数あれば、どれも強調する', () => {
    const segs = snippetSegments('明日の会議の資料', '会議 資料');
    expect(segs.filter((s) => s.hit).map((s) => s.text)).toEqual(['会議', '資料']);
  });

  it('長い本文は一致の前後だけを切り出し、「…」を付ける', () => {
    const body = 'あ'.repeat(100) + '会議' + 'い'.repeat(100);
    const segs = snippetSegments(body, '会議');
    expect(segs[0]).toEqual({ text: '…', hit: false });
    expect(segs.at(-1)).toEqual({ text: '…', hit: false });
    expect(segs.find((s) => s.hit)?.text).toBe('会議');
    const plain = segs.map((s) => s.text).join('');
    expect(plain.length).toBeLessThanOrEqual(2 * 40 + 2 + 2 + 2);
  });

  it('改行は空白にする。一致がなければ冒頭だけ', () => {
    expect(snippetSegments('一行目\n二行目', 'なし')).toEqual([{ text: '一行目 二行目', hit: false }]);
  });

  it('正規表現の記号を語として扱う', () => {
    expect(snippetSegments('100% (done)', '(done)')).toEqual([
      { text: '100% ', hit: false },
      { text: '(done)', hit: true },
    ]);
  });
});
