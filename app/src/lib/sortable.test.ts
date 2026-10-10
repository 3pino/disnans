import { describe, expect, it } from 'vitest';
import { dropSlot, finalPositions, moveItem, slotToIndex } from './sortable';

describe('dropSlot', () => {
  const rows = [
    { top: 0, bottom: 40 },
    { top: 44, bottom: 84 },
    { top: 88, bottom: 128 },
  ];

  it('差し込み位置は行の中央で決まる', () => {
    expect(dropSlot(rows, -10)).toBe(0);
    expect(dropSlot(rows, 19)).toBe(0);
    expect(dropSlot(rows, 21)).toBe(1);
    expect(dropSlot(rows, 100)).toBe(2);
    expect(dropSlot(rows, 500)).toBe(3);
  });

  it('並びが空なら 0', () => {
    expect(dropSlot([], 100)).toBe(0);
  });
});

describe('slotToIndex', () => {
  it('差し込み位置を、抜いたあとの並びの位置に直す', () => {
    // 2番目（0 始まりで1）の行を、その前（slot 1）に戻す → 同じ位置
    expect(slotToIndex(1, 1)).toBe(1);
    // 1 の行を、末尾の後ろ（slot 3）に入れる → 最後（2）
    expect(slotToIndex(0, 3)).toBe(2);
    // 2 の行を、先頭の前（slot 0）に入れる → 先頭（0）
    expect(slotToIndex(2, 0)).toBe(0);
  });
});

describe('moveItem', () => {
  it('from の項目を、動かしたあとの位置 to に入れる（新しい配列を返す）', () => {
    const list = ['a', 'b', 'c', 'd'];
    expect(moveItem(list, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(list, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveItem(list, 1, 1)).toEqual(list);
    expect(moveItem(list, 1, 1)).not.toBe(list);
    expect(list).toEqual(['a', 'b', 'c', 'd']);
  });

  it('to は範囲に収める。from が範囲外ならコピーを返す', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 99)).toEqual(['b', 'c', 'a']);
    expect(moveItem(['a', 'b', 'c'], 2, -4)).toEqual(['c', 'a', 'b']);
    expect(moveItem(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
    expect(moveItem(['a', 'b'], -1, 0)).toEqual(['a', 'b']);
  });
});

describe('finalPositions', () => {
  it('元の位置 k の項目が最終的に入る位置を返す（ドラッグ中にほかの行をずらす先）', () => {
    // 0 を 2 に動かす → 1 は上へ、2 は上へ、0 は 2 へ、3 はそのまま
    expect(finalPositions(4, 0, 2)).toEqual([2, 0, 1, 3]);
    // 3 を 0 に動かす → 全部1つ下へ
    expect(finalPositions(4, 3, 0)).toEqual([1, 2, 3, 0]);
    // 動かさないときは、そのまま
    expect(finalPositions(3, 1, 1)).toEqual([0, 1, 2]);
  });

  it('入れ替えの結果と一致する（位置の表は moveItem と同じ並びを作る）', () => {
    const n = 5;
    for (let from = 0; from < n; from++) {
      for (let to = 0; to < n; to++) {
        const pos = finalPositions(n, from, to);
        const moved = moveItem(['0', '1', '2', '3', '4'], from, to);
        pos.forEach((p, k) => expect(moved[p]).toBe(String(k)));
      }
    }
  });
});
