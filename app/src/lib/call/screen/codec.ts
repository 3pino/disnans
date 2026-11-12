/**
 * 画面の 1 枚を、送れる画像にする純粋な部品。
 * DOM は作らない（canvas は引数で受ける。読み込むときに DOM を触らない）。
 * 送り手（sender）と、設定の見本（settings の preview）が使う。
 */

import { SERVER_BUDGET_KBPS, type ColorMode } from './constants';
import { sniffImageMime } from './protocol';
import { quantizeRgba } from './quantize';
export { QUALITY_PRESETS, FPS_OPTIONS, COLOR_MODES, SERVER_BUDGET_KBPS, type QualityPreset, type ColorMode } from './constants';
export { sniffImageMime } from './protocol';

/** 符号化の結果（mime は実際の形式。b64 は base64 の本体） */
export type EncodedFrame = { mime: string; b64: string };

/** 符号化に要る canvas の口（DOM の HTMLCanvasElement の必要な部分だけ） */
export type EncodeCanvas = {
  width: number;
  height: number;
  getContext(kind: '2d', opts?: { willReadFrequently?: boolean }): EncodeContext | null;
  toDataURL(type: string, quality?: number): string;
};
export type EncodeContext = {
  drawImage(source: unknown, dx: number, dy: number, dw: number, dh: number): void;
  getImageData(sx: number, sy: number, sw: number, sh: number): { data: Uint8ClampedArray };
  putImageData(img: { data: Uint8ClampedArray }, dx: number, dy: number): void;
};

/** 長辺が maxEdge に収まるように縮小した大きさ。拡大はしない。scale は画質調整の倍率 */
export function fitSize(w: number, h: number, maxEdge: number, scale = 1): { w: number; h: number } {
  const r = Math.min(1, (maxEdge * scale) / Math.max(w, h, 1));
  return { w: Math.max(1, Math.round(w * r)), h: Math.max(1, Math.round(h * r)) };
}


/**
 * 画素（RGBA）の色数を減らす。渡した配列をそのまま書き換える。
 * c256: この画面の色から選んだ 256 色の代表色（quantize.ts。アルファは残す） / gray: 輝度だけ（R=G=B）
 */
export function applyColorMode(data: Uint8ClampedArray, mode: ColorMode | string): void {
  if (mode === 'c256') {
    quantizeRgba(data);
  } else if (mode === 'gray') {
    for (let i = 0; i + 3 < data.length; i += 4) {
      const y = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
      data[i] = data[i + 1] = data[i + 2] = y;
    }
  }
}

/** 色数の設定で試す画像の形式（小さいものが選ばれる）。フルカラーは JPEG だけ */
export function candidateFormats(mode: ColorMode | string): string[] {
  if (mode === 'c256') return ['image/png', 'image/webp'];
  if (mode === 'gray') return ['image/jpeg', 'image/webp', 'image/png'];
  return ['image/jpeg'];
}

/** 形式ごとのサイズから、いちばん小さい形式を選ぶ（同じなら先に挙げたほう）。空なら null */
export function pickSmallest(sizes: Readonly<Record<string, number>>): string | null {
  let best: string | null = null;
  for (const [mime, n] of Object.entries(sizes)) if (best === null || n < sizes[best]) best = mime;
  return best;
}

/** 1 フレームのサイズと、動き続けたときの帯域の見積もり（サーバーの予算を超える分は間隔が空く） */
export function estimateBandwidth(b64Length: number, fps: number, budgetKBps = SERVER_BUDGET_KBPS): { imageBytes: number; bytesPerSec: number; capped: boolean } {
  const imageBytes = Math.floor((b64Length * 3) / 4);
  const raw = b64Length * fps;
  const cap = budgetKBps * 1024;
  return { imageBytes, bytesPerSec: Math.min(raw, cap), capped: raw > cap };
}

/** バイト数を読みやすくする（KB / MB） */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * source を w×h に縮小して canvas に描き、色数を減らし、画像にする。
 * format を省くと（null）、色数に合う形式をすべて試して、いちばん小さいものを返す。
 * 作れない形式は PNG などに替わって返ってくるので、実際の形式で数える。
 */
export function encodeFrame(
  cv: EncodeCanvas,
  source: unknown,
  w: number,
  h: number,
  o: { color: ColorMode | string; quality: number; format: string | null },
): EncodedFrame {
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d', o.color === 'full' ? undefined : { willReadFrequently: true });
  if (!ctx) throw new Error('canvas を使えません');
  ctx.drawImage(source, 0, 0, w, h);
  if (o.color !== 'full') {
    const img = ctx.getImageData(0, 0, w, h);
    applyColorMode(img.data, o.color);
    ctx.putImageData(img, 0, 0);
  }
  const sizes: Record<string, number> = {};
  const images: Record<string, string> = {};
  for (const want of o.format ? [o.format] : candidateFormats(o.color)) {
    const url = cv.toDataURL(want, o.quality);
    const b64 = url.slice(url.indexOf(',') + 1);
    const mime = sniffImageMime(b64) ?? want;
    if (!(mime in sizes)) {
      sizes[mime] = b64.length;
      images[mime] = b64;
    }
  }
  const mime = pickSmallest(sizes) ?? 'image/jpeg';
  return { mime, b64: images[mime] ?? '' };
}
