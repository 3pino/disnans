/**
 * 送信ボタンを上へスワイプして「通知なしで送信」にする判定。
 * 指の追跡と表示は Composer.svelte の側で行い、ここは数値の判定だけを持つ。
 */

/** 離したときに silent で送る、上への動き（px） */
export const SILENT_SWIPE_PX = 40;
/** 送信ボタンが上へずれる最大（px） */
export const SILENT_SWIPE_MAX_PX = 56;

/** 開始点から上への動き（px）。下へは動かさない（0） */
export function swipeUpLift(startY: number, y: number): number {
  return Math.max(0, startY - y);
}

/** 離したときに silent で送るか */
export function isSilentSwipe(lift: number): boolean {
  return lift >= SILENT_SWIPE_PX;
}

/** 送信ボタンを上へずらす量（px、正の値。上限あり） */
export function sendButtonLift(lift: number): number {
  return Math.min(Math.max(0, lift), SILENT_SWIPE_MAX_PX);
}
