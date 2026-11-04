/**
 * 画面共有の表示（拡大・移動・ダブルタップ）の純粋な計算。DOM を使わないのでテストできる。
 * 元は examples/screenshare/main.js の同じ関数（その例は残す）。
 */

export type ViewState = { scale: number; x: number; y: number };

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;
/** ダブルタップで拡大する倍率 */
export const DOUBLE_TAP_ZOOM = 2.5;
/** Ctrl+ホイール（トラックパッドのピンチ）の拡大の速さ（1 ピクセルあたり）と、1 回の上限 */
const PINCH_ZOOM_RATE = 0.01;
const PINCH_MAX_DELTA = 30;
/** 修飾キーなしのホイールで拡大するときの速さと、1 回の上限 */
const WHEEL_ZOOM_RATE = 0.002;
const WHEEL_MAX_DELTA = 120;

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 画像を舞台に「全体が収まる」ように置いたときの大きさ（倍率 1）。小さい画像も舞台いっぱいまで広げる */
export function containSize(natural: { w: number; h: number }, stage: { w: number; h: number }): { w: number; h: number } {
  if (natural.w <= 0 || natural.h <= 0 || stage.w <= 0 || stage.h <= 0) return { w: 0, h: 0 };
  const r = Math.min(stage.w / natural.w, stage.h / natural.h);
  return { w: natural.w * r, h: natural.h * r };
}

export type WheelInput = { deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean };
export type WheelAction = { kind: 'zoom'; factor: number } | { kind: 'pan'; dx: number; dy: number } | null;

/**
 * ホイールの操作を、拡大縮小か移動に読み替える。
 * - Ctrl（または Meta）+ ホイール: 拡大縮小（トラックパッドのピンチもこれで届く）
 * - 拡大中のホイール: 移動（Shift なら横）
 * - 等倍で上へ回す: 拡大（埋め込みの表示では、ページのスクロールに譲る）
 */
export function wheelAction(e: WheelInput, o: { scale: number; embedded: boolean; pageHeight: number }): WheelAction {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? Math.max(1, o.pageHeight) : 1;
  let dx = e.deltaX * unit;
  let dy = e.deltaY * unit;
  if (e.ctrlKey || e.metaKey) return { kind: 'zoom', factor: Math.exp(-clamp(dy, -PINCH_MAX_DELTA, PINCH_MAX_DELTA) * PINCH_ZOOM_RATE) };
  if (o.scale > MIN_ZOOM + 1e-6) {
    if (e.shiftKey && dx === 0) [dx, dy] = [dy, 0];
    return { kind: 'pan', dx, dy };
  }
  if (!o.embedded && dy < 0) return { kind: 'zoom', factor: Math.exp(-clamp(dy, -WHEEL_MAX_DELTA, WHEEL_MAX_DELTA) * WHEEL_ZOOM_RATE) };
  return null;
}

/** 画像が舞台からはみ出さない範囲にパンを収める（小さければ中央） */
export function clampView(v: ViewState, stage: { w: number; h: number }, img: { w: number; h: number }): ViewState {
  const scale = clamp(v.scale, MIN_ZOOM, MAX_ZOOM);
  const maxX = Math.max(0, (img.w * scale - stage.w) / 2);
  const maxY = Math.max(0, (img.h * scale - stage.h) / 2);
  return { scale, x: clamp(v.x, -maxX, maxX), y: clamp(v.y, -maxY, maxY) };
}

/** 点 (px, py)（舞台の中心からの位置）が動かないように、倍率を変える */
export function zoomAt(v: ViewState, newScale: number, px: number, py: number): ViewState {
  const scale = clamp(newScale, MIN_ZOOM, MAX_ZOOM);
  const k = scale / v.scale;
  return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
}

/** ピンチ（と 1 本指のパン）。始めの表示 v0・中点 m0・間隔 d0 と、いまの中点 m1・間隔 d1 から表示を求める */
export function pinchView(v0: ViewState, m0: { x: number; y: number }, d0: number, m1: { x: number; y: number }, d1: number): ViewState {
  const scale = clamp(v0.scale * (d0 > 0 ? d1 / d0 : 1), MIN_ZOOM, MAX_ZOOM);
  const cx = (m0.x - v0.x) / v0.scale;
  const cy = (m0.y - v0.y) / v0.scale;
  return { scale, x: m1.x - cx * scale, y: m1.y - cy * scale };
}

/** ダブルタップか（前のタップから短い時間で、近い場所） */
export function isDoubleTap(prev: { t: number; x: number; y: number } | null, cur: { t: number; x: number; y: number }): boolean {
  return prev !== null && cur.t - prev.t < 320 && Math.hypot(cur.x - prev.x, cur.y - prev.y) < 36;
}

/** デスクトップの PiP（canvas の captureStream を <video> で requestPictureInPicture）が使えるか */
export function canWebPip(
  doc: { pictureInPictureEnabled?: boolean } | undefined | null,
  videoProto: { requestPictureInPicture?: unknown } | undefined | null,
  canvasProto: { captureStream?: unknown } | undefined | null,
): boolean {
  return doc?.pictureInPictureEnabled === true && typeof videoProto?.requestPictureInPicture === 'function' && typeof canvasProto?.captureStream === 'function';
}

/** ダブルタップで拡大／元に戻す先の表示（今が等倍より大きければ戻す） */
export function doubleTapView(v: ViewState, tap: { x: number; y: number }): ViewState {
  if (v.scale > MIN_ZOOM + 1e-6) return { scale: MIN_ZOOM, x: 0, y: 0 };
  return zoomAt(v, DOUBLE_TAP_ZOOM, tap.x, tap.y);
}
