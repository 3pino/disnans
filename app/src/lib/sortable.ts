/**
 * 並べ替えの純粋関数（ドラッグ・上下キー・左スワイプの判定。DOM は使わない）。
 * 並べ替えの部品は components/ui/SortableList.svelte。テストは sortable.test.ts
 */
import { swipeAxis, swipeTriggered } from './swipe';

/** タッチで、動かさずにこの時間（ms）押したら並べ替えを始める。それより前の縦の動きはページのスクロール */
export const TOUCH_DRAG_HOLD_MS = 400;
/** 左スワイプで出す「削除」ボタンの幅（px）。離したとき、これ以上の動きなら出したままにする */
export const REVEAL_PX = 88;

/**
 * キーボードで動かす先。上下キー・Home・End のとき、動かす先の位置を返す。
 * 動かさない（範囲の外・同じ位置・ほかのキー）ときは null
 */
export function keyMoveTarget(key: string, index: number, length: number): number | null {
  let to: number;
  if (key === 'ArrowUp') to = index - 1;
  else if (key === 'ArrowDown') to = index + 1;
  else if (key === 'Home') to = 0;
  else if (key === 'End') to = length - 1;
  else return null;
  if (to < 0 || to >= length || to === index) return null;
  return to;
}

/**
 * 指を離したあと、削除ボタンを出したままにするか。取り消し（pointercancel など）では出さない。
 * 離した位置が削除のしきい値を超えていたときだけ出す
 */
export function revealAfterEnd(dx: number, cancelled: boolean): boolean {
  return !cancelled && swipeTriggered(dx);
}

/** 並べている項目の ID の並びが同じか（ドラッグの途中で並びが外から変わったら、操作を取り消すため） */
export function sameIdOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** 行の指の動きで、何を始めるか。'drag' 並べ替え・'swipe' 左スワイプ・'scroll' ページのスクロール（手を離す）・'ignore' 右への横の動き */
export type RowGesture = 'drag' | 'swipe' | 'scroll' | 'ignore';

/**
 * 指の動き（開始点からの差）から、行で何を始めるか。まだ横か縦か決まらないなら null。
 * 縦: マウス・ペンは並べ替え。タッチは、長押しのあと（held）だけ並べ替え、それ以外はページのスクロール。
 * 横: 左は削除のスワイプ、右は何もしない。
 */
export function rowGesture(pointerType: string, dx: number, dy: number, held: boolean): RowGesture | null {
  const axis = swipeAxis(dx, dy);
  if (axis === null) return null;
  if (axis === 'y') return pointerType === 'touch' && !held ? 'scroll' : 'drag';
  return dx < 0 ? 'swipe' : 'ignore';
}

/**
 * ドラッグ中の差し込み位置（slot）。rows は並びの上から各行の上端と下端、y はポインターの縦位置。
 * 行の中央より上にある行の数を返す（0 なら先頭の前、rows.length なら末尾の後ろ）
 */
export function dropSlot(rows: { top: number; bottom: number }[], y: number): number {
  return rows.filter((r) => (r.top + r.bottom) / 2 < y).length;
}

/** 差し込み位置を、動かしたあとの並びの位置に直す（from の行を抜いた分だけ、後ろの位置が1つ詰まる） */
export function slotToIndex(from: number, slot: number): number {
  return slot > from ? slot - 1 : slot;
}

/**
 * 項目を from から to（動かしたあとの位置）に動かした新しい配列を返す。to は範囲に収める。
 * from が範囲外なら、同じ並びのコピーを返す
 */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length) return out;
  const [item] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, item);
  return out;
}

/**
 * from の項目を to に動かしたとき、元の位置 k の項目が最終的に入る位置を、k 番目の要素として返す。
 * ドラッグの間、ほかの行をどれだけ動かすかを決めるのに使う
 */
export function finalPositions(n: number, from: number, to: number): number[] {
  const order = moveItem(
    Array.from({ length: n }, (_, i) => i),
    from,
    to,
  );
  const pos = new Array<number>(n);
  order.forEach((orig, p) => (pos[orig] = p));
  return pos;
}
