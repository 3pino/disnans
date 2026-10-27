// 拡大表示（components/Lightbox.svelte）の、左右のスワイプで前後へ移るかの決まり

/** 前後のファイルの間の空き（px） */
export const SLIDE_GAP = 24;

/** 端（続きが無い向き）へ動かしたときの、指に対する動きの割合 */
export const SWIPE_EDGE_RESISTANCE = 0.3;

/** 移るのに要る距離（幅に対する割合） */
const DISTANCE_RATIO = 0.25;
/** 短い距離でも、速く払えば移る（px/ms）。ただし最低限の距離は要る（px） */
const FLICK_SPEED = 0.5;
const FLICK_MIN = 40;

/**
 * 指を離したときに、どちらへ移るか。dx は指の横の移動量（左へ動かすと負）、ms はかかった時間、width は画面の幅。
 * 左へ払ったら次（+1）、右へ払ったら前（-1）、足りなければ null（元に戻す）
 */
export function swipeOutcome(dx: number, ms: number, width: number): -1 | 1 | null {
  const far = Math.abs(dx) >= width * DISTANCE_RATIO;
  const flick = Math.abs(dx) >= FLICK_MIN && Math.abs(dx) / Math.max(1, ms) >= FLICK_SPEED;
  if (!far && !flick) return null;
  return dx < 0 ? 1 : -1;
}
