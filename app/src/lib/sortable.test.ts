import { describe, expect, it } from 'vitest';
import {
  REVEAL_PX,
  TOUCH_DRAG_HOLD_MS,
  dropSlot,
  finalPositions,
  keyMoveTarget,
  moveItem,
  revealAfterEnd,
  rowGesture,
  sameIdOrder,
  slotToIndex,
} from './sortable';

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

describe('rowGesture（行の指の動きで何を始めるか）', () => {
  it('8px に届くまでは決めない（小さな揺れ）', () => {
    expect(rowGesture('mouse', 3, 4, false)).toBeNull();
    expect(rowGesture('touch', -7, 0, false)).toBeNull();
  });

  it('マウス・ペンは、縦に動けば並べ替え', () => {
    expect(rowGesture('mouse', 0, 12, false)).toBe('drag');
    expect(rowGesture('pen', 2, -20, false)).toBe('drag');
  });

  it('タッチは、長押しの前の縦はページのスクロール。長押しのあとは並べ替え', () => {
    expect(rowGesture('touch', 0, 12, false)).toBe('scroll');
    expect(rowGesture('touch', 0, 12, true)).toBe('drag');
  });

  it('左への横の動きは削除のスワイプ（タッチも、マウスも）', () => {
    expect(rowGesture('touch', -30, 2, false)).toBe('swipe');
    expect(rowGesture('mouse', -30, 2, false)).toBe('swipe');
  });

  it('右への横の動きは何もしない（縦が強ければ縦として扱う）', () => {
    expect(rowGesture('mouse', 30, 2, false)).toBe('ignore');
    expect(rowGesture('mouse', 10, 30, false)).toBe('drag');
  });

  it('横の判定は、縦より横が大きいとき（斜めは縦）', () => {
    expect(rowGesture('mouse', -10, -10, false)).toBe('drag');
  });
});

describe('タッチの長押しと削除ボタン', () => {
  it('長押しの時間と削除ボタンの幅は、既定の値（変えたら設計に理由を書く）', () => {
    expect(TOUCH_DRAG_HOLD_MS).toBe(400);
    expect(REVEAL_PX).toBe(88);
  });
});

describe('keyMoveTarget（上下キー・Home・End）', () => {
  it('上下キーは一つずつ、Home・End は端へ', () => {
    expect(keyMoveTarget('ArrowDown', 1, 4)).toBe(2);
    expect(keyMoveTarget('ArrowUp', 2, 4)).toBe(1);
    expect(keyMoveTarget('Home', 2, 4)).toBe(0);
    expect(keyMoveTarget('End', 1, 4)).toBe(3);
  });

  it('端では動かさない（null）。同じ位置へも動かさない', () => {
    expect(keyMoveTarget('ArrowUp', 0, 4)).toBeNull();
    expect(keyMoveTarget('ArrowDown', 3, 4)).toBeNull();
    expect(keyMoveTarget('Home', 0, 4)).toBeNull();
    expect(keyMoveTarget('End', 3, 4)).toBeNull();
  });

  it('ほかのキーでは動かさない（Enter・Space・文字など）', () => {
    for (const key of ['Enter', ' ', 'a', 'Tab']) expect(keyMoveTarget(key, 1, 4)).toBeNull();
  });

  it('項目が一つ以下なら何も動かさない', () => {
    expect(keyMoveTarget('ArrowDown', 0, 1)).toBeNull();
    expect(keyMoveTarget('End', 0, 0)).toBeNull();
  });
});

describe('revealAfterEnd（指を離したあと、削除ボタンを出すか）', () => {
  it('しきい値を超えて離したら出す。届かなければ出さない', () => {
    expect(revealAfterEnd(-60, false)).toBe(true);
    expect(revealAfterEnd(-59, false)).toBe(false);
    expect(revealAfterEnd(0, false)).toBe(false);
  });

  it('取り消し（pointercancel など）では、しきい値を超えていても出さない', () => {
    expect(revealAfterEnd(-120, true)).toBe(false);
  });

  it('右への動きでは出さない', () => {
    expect(revealAfterEnd(80, false)).toBe(false);
  });
});

describe('sameIdOrder（並びの変化を見つける）', () => {
  it('同じ ID の同じ順なら同じ', () => {
    expect(sameIdOrder(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameIdOrder([], [])).toBe(true);
  });

  it('順が違う・増減・ID が違うなら違う', () => {
    expect(sameIdOrder(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameIdOrder(['a', 'b'], ['a'])).toBe(false);
    expect(sameIdOrder(['a', 'b'], ['a', 'c'])).toBe(false);
  });
});
