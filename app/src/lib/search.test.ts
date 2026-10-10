import { describe, expect, it } from 'vitest';
import { appendOlder, chronological, matchRanges, searchTerms } from './search';

describe('searchTerms', () => {
  it('空白で区切り、空の語は除く', () => {
    expect(searchTerms('  会議  資料 ')).toEqual(['会議', '資料']);
    expect(searchTerms('   ')).toEqual([]);
  });
});

describe('matchRanges', () => {
  it('一致の範囲を返す（大文字・小文字は区別しない）', () => {
    expect(matchRanges('Hello World hello', 'hello')).toEqual([
      [0, 5],
      [12, 17],
    ]);
  });

  it('複数の語はどれも拾い、長い語を優先する', () => {
    expect(matchRanges('会議資料', '会議 会議資料')).toEqual([[0, 4]]);
    expect(matchRanges('明日の会議の資料', '会議 資料')).toEqual([
      [3, 5],
      [6, 8],
    ]);
  });

  it('語が空なら空', () => {
    expect(matchRanges('abc', '  ')).toEqual([]);
  });
});

describe('chronological / appendOlder', () => {
  it('新しい順を古い順にする（元は変えない）', () => {
    const src = [3, 2, 1];
    expect(chronological(src)).toEqual([1, 2, 3]);
    expect(src).toEqual([3, 2, 1]);
  });

  it('次のページは重なりを除いて後ろに足す', () => {
    expect(appendOlder([{ id: 'c' }, { id: 'b' }], [{ id: 'b' }, { id: 'a' }])).toEqual([{ id: 'c' }, { id: 'b' }, { id: 'a' }]);
  });
});
