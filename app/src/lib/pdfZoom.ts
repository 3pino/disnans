// PDF のプレビュー（PdfViewer）の拡大・縮小の計算。1 = 幅に合わせる

export const PDF_MIN_ZOOM = 1;
export const PDF_MAX_ZOOM = 4;
/** ボタンで進む段階 */
const STEPS = [1, 1.5, 2, 3, 4];
/** ダブルタップで拡大するときの倍率 */
export const PDF_DOUBLE_TAP_ZOOM = 2;

export function clampZoom(z: number): number {
  return Math.min(PDF_MAX_ZOOM, Math.max(PDF_MIN_ZOOM, z));
}

/** ボタンの次の段階（dir: 1 で拡大、-1 で縮小）。ピンチで段階の間にいても、その先の段階へ */
export function stepZoom(z: number, dir: 1 | -1): number {
  if (dir > 0) return STEPS.find((s) => s > z + 0.01) ?? PDF_MAX_ZOOM;
  return [...STEPS].reverse().find((s) => s < z - 0.01) ?? PDF_MIN_ZOOM;
}

/**
 * 倍率を ratio 倍にしたあとのスクロール位置。anchor（スクロールの枠の左上からの位置）の下にあった場所が、同じ所に残る
 */
export function anchoredScroll(
  scroll: { left: number; top: number },
  anchor: { x: number; y: number },
  ratio: number,
): { left: number; top: number } {
  return {
    left: Math.max(0, (scroll.left + anchor.x) * ratio - anchor.x),
    top: Math.max(0, (scroll.top + anchor.y) * ratio - anchor.y),
  };
}
