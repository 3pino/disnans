/**
 * 画像の拡大縮小・移動の計算（純粋関数。zoom.test.ts で試す）。Lightbox.svelte から使う。
 *
 * 表示の状態 ZoomView は、舞台（全画面）の中心を原点にした座標で持つ。画像は舞台の中心に置かれ、
 * その中心を基準に translate(x, y) scale(scale) で表示する。x・y は中心からのずれ（px）。
 */

/** 表示の変換。scale = 倍率、x・y = 中心からのずれ（px） */
export type ZoomView = { scale: number; x: number; y: number };

/** 舞台の中心からの位置（px） */
export type Point = { x: number; y: number };

/** 大きさ（px） */
export type Size = { w: number; h: number };

/** 最小（等倍）と最大の倍率 */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 5;

/** ダブルタップで拡大するときの倍率（拡大中なら等倍に戻す） */
export const DOUBLE_TAP_ZOOM = 2.5;

/** 等倍・中央 */
export const IDENTITY_VIEW: ZoomView = { scale: 1, x: 0, y: 0 };

/** ダブルタップとみなす、前のタップからの時間（ms）と距離（px） */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 24;

/** ctrl+ホイール 1px あたりの拡大率の変化（トラックパッドのピンチはこの量の小さい差が続く） */
const WHEEL_SENSITIVITY = 0.005;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 倍率を MIN_ZOOM〜MAX_ZOOM に収める */
export function clampScale(scale: number): number {
  return clamp(scale, MIN_ZOOM, MAX_ZOOM);
}

/**
 * 画像が舞台からはみ出さない範囲に移動を収める（画像が舞台より小さければ中央）。倍率も収める。
 * @param v 表示の状態
 * @param stage 舞台の大きさ
 * @param img 倍率 1 のときの画像の表示の大きさ
 */
export function clampView(v: ZoomView, stage: Size, img: Size): ZoomView {
  const scale = clampScale(v.scale);
  const maxX = Math.max(0, (img.w * scale - stage.w) / 2);
  const maxY = Math.max(0, (img.h * scale - stage.h) / 2);
  return { scale, x: clamp(v.x, -maxX, maxX), y: clamp(v.y, -maxY, maxY) };
}

/**
 * 点 p（舞台の中心からの位置）の下にある画像の点が動かないように、倍率を変える。
 * @param v 表示の状態
 * @param newScale 新しい倍率（MIN_ZOOM〜MAX_ZOOM に収める）
 * @param p 基準にする点
 */
export function zoomAt(v: ZoomView, newScale: number, p: Point): ZoomView {
  const scale = clampScale(newScale);
  const k = scale / v.scale;
  return { scale, x: p.x - (p.x - v.x) * k, y: p.y - (p.y - v.y) * k };
}

/**
 * ピンチ（と 1 本指のパン）。始めたときの表示 v0・指の中点 m0・指の間隔 d0 と、いまの中点 m1・間隔 d1 から表示を求める。
 * 始めに指の下にあった点が、いまの中点の下に来るようにする。1 本指のパンは d0 = d1 = 0 で呼ぶ（倍率は変わらない）。
 * @param v0 始めたときの表示
 * @param m0 始めたときの中点
 * @param d0 始めたときの指の間隔（1 本指なら 0）
 * @param m1 いまの中点
 * @param d1 いまの指の間隔（1 本指なら 0）
 */
export function pinchView(v0: ZoomView, m0: Point, d0: number, m1: Point, d1: number): ZoomView {
  const scale = clampScale(v0.scale * (d0 > 0 ? d1 / d0 : 1));
  const cx = (m0.x - v0.x) / v0.scale;
  const cy = (m0.y - v0.y) / v0.scale;
  return { scale, x: m1.x - cx * scale, y: m1.y - cy * scale };
}

/**
 * ctrl+ホイールの 1 回ぶんの拡大率。deltaY が負（上へ回す・ピンチで広げる）なら拡大する。
 * @param scale いまの倍率
 * @param deltaY WheelEvent.deltaY
 */
export function zoomByWheel(scale: number, deltaY: number): number {
  return clampScale(scale * Math.exp(-deltaY * WHEEL_SENSITIVITY));
}

/** タップの記録（t は時刻 ms、x・y は舞台の中心からの位置） */
export type TapRecord = { t: number; x: number; y: number };

/**
 * ダブルタップか（前のタップから短い時間で、近い場所）。
 * @param prev 前のタップ（なければ null）
 * @param cur いまのタップ
 */
export function isDoubleTap(prev: TapRecord | null, cur: TapRecord): boolean {
  if (!prev) return false;
  return cur.t - prev.t <= DOUBLE_TAP_MS && Math.hypot(cur.x - prev.x, cur.y - prev.y) <= DOUBLE_TAP_PX;
}
