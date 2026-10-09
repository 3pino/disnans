/**
 * メッセージを左にスワイプして返信する操作の判定。
 * 画面の描画と指の追跡は MessageItem.svelte の側で行い、ここは数値の判定だけを持つ。
 */

/** 横か縦かを決めるまでに必要な動き（px）。小さな揺れで決めないため */
export const SWIPE_LOCK_PX = 8;
/** 離したときに返信が発動する、左への動き（px） */
export const SWIPE_TRIGGER_PX = 60;
/** 吹き出しが左へ動ける最大（px） */
export const SWIPE_MAX_PX = 96;

export type SwipeAxis = 'x' | 'y';

/**
 * 指の動き（開始点からの差）から、横か縦かを決める。
 * どちらも SWIPE_LOCK_PX に届くまでは null（まだ決めない）。横の動きが縦より大きいときだけ 'x'。
 */
export function swipeAxis(dx: number, dy: number): SwipeAxis | null {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_LOCK_PX) return null;
  return Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
}

/**
 * 吹き出しの横の位置（px、左へ動くほど負）。指に追従し、しきい値を超えると重くなる。
 * 右への動きは無視する（0）。
 */
export function swipeOffset(dx: number): number {
  const d = Math.max(0, -dx);
  const eased = d <= SWIPE_TRIGGER_PX ? d : SWIPE_TRIGGER_PX + (d - SWIPE_TRIGGER_PX) * 0.35;
  // 0 のときに -0 を返さないようにする
  return eased === 0 ? 0 : -Math.min(eased, SWIPE_MAX_PX);
}

/** 離したときに返信が発動するか */
export function swipeTriggered(dx: number): boolean {
  return -dx >= SWIPE_TRIGGER_PX;
}

/** 返信アイコンの見え方（0〜1）。しきい値に近づくほど濃くなる */
export function swipeProgress(dx: number): number {
  return Math.min(1, Math.max(0, -dx) / SWIPE_TRIGGER_PX);
}
