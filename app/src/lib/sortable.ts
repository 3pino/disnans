/**
 * 並べ替えの純粋関数（ドラッグ・上下キー・左スワイプの判定。DOM は使わない）。
 * 並べ替えの部品は components/ui/SortableList.svelte。テストは sortable.test.ts
 */
import { swipeAxis } from './swipe';

/** タッチで、動かさずにこの時間（ms）押したら並べ替えを始める。それより前の縦の動きはページのスクロール */
export const TOUCH_DRAG_HOLD_MS = 400;
/** 左スワイプで止まる位置（削除ボタンの幅・px）。離したとき、REVEAL_TRIGGER_PX 以上なら、ここで止めて出したままにする */
export const REVEAL_PX = 88;
/**
 * 離したときに、ボタンを出したまま止まる左への動き（px）。小さな引きや指の揺れで出ないよう、ボタンの幅より手前にする。
 * 届かなければ閉じる
 */
export const REVEAL_TRIGGER_PX = 60;
/**
 * 行の幅に対する割合。これ以上まで引いて離すと、ボタンを押さずに削除する。
 * 60% は、縦のスクロールの横ずれ（行の端まで届くほどの横の動き）では起きない大きさ。手前で止める（ボタンを出す）操作と分けるため。
 */
export const FULL_SWIPE_RATIO = 0.6;
/** 即削除のとき、行を画面の外へ滑らせる時間（ms）。CSS の transition（180ms）と合わせる */
export const ROW_LEAVE_MS = 180;

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

/** 行の左スワイプで、行の位置（左へ動くほど負）。指に合わせて動き、行の幅より先へは行かない */
export function rowSwipeOffset(dx: number, width: number): number {
  return Math.max(-width, Math.min(0, dx));
}

/**
 * 即削除に届く、左への動き（px）。幅が分からない（0 以下）ときは届かないものとする（誤って消さない）
 */
export function fullSwipeDistance(width: number): number {
  return width > 0 ? width * FULL_SWIPE_RATIO : Infinity;
}

/**
 * 指を離したあとの扱い。取り消し（pointercancel など）は閉じる。
 * delete: 行の幅の割合まで引いた（即削除）。open: ボタンを出したまま止める。close: 元に戻す
 */
export function releaseAction(dx: number, width: number, cancelled: boolean): 'delete' | 'open' | 'close' {
  if (cancelled) return 'close';
  const pulled = -dx;
  if (pulled >= fullSwipeDistance(width)) return 'delete';
  if (pulled >= REVEAL_TRIGGER_PX) return 'open';
  return 'close';
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
