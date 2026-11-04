/**
 * 送る間隔・画質の調整・送信の重さ（純粋な関数）。examples/screenshare/main.js から移した値と式のまま。
 */
import { SERVER_BUDGET_KBPS, type QualityPreset } from './constants';
export { SERVER_BUDGET_KBPS, QUALITY_PRESETS, type QualityPreset } from './constants';
/** フレームを送る間隔の上限（ミリ秒）。重いフレームが続いても、これより遅くはしない */
export const MAX_DELAY_MS = 5000;
/** 画面が変わらなくても、あとから来た人のために送り直す間隔（ミリ秒） */
export const KEEPALIVE_FRAME_MS = 5000;
/** 送信待ちがこれより多いあいだは、次のフレームを作らずに待つ（バイト） */
export const BACKLOG_LIMIT = 192 * 1024;
const MIN_QUALITY = 0.35;
const MIN_SCALE = 0.4;

/** フレーム 1 枚の重さ（分割した 1 回ごとに 1、さらに payload の KB） */
export function frameWeight(bytes: number, chunks: number): number {
  return chunks + bytes / 1024;
}

/** 次のフレームまでの間隔（ミリ秒）。fps の上限と、予算に収まる間隔のうち長いほう */
export function nextInterval(o: { fps: number; weight: number; budgetKBps: number }): number {
  const byFps = 1000 / Math.max(o.fps, 0.1);
  const byBudget = (o.weight / Math.max(o.budgetKBps, 1)) * 1000;
  return Math.min(MAX_DELAY_MS, Math.max(byFps, byBudget));
}

/** 画質（quality と縮小の倍率 scale）を、直前のフレームの大きさに合わせて 1 段階だけ動かす */
export function tuneQuality(
  cur: { quality: number; scale: number },
  bytes: number,
  preset: QualityPreset,
  budgetKBps: number = SERVER_BUDGET_KBPS,
): { quality: number; scale: number } {
  const limit = budgetKBps * 1024 * 0.6;
  let { quality, scale } = cur;
  if (bytes > limit) {
    if (quality > MIN_QUALITY + 1e-9) quality = Math.max(MIN_QUALITY, quality - 0.1);
    else scale = Math.max(MIN_SCALE, scale * 0.8);
  } else if (bytes < limit * 0.5) {
    if (scale < 1) scale = Math.min(1, scale * 1.15);
    else quality = Math.min(preset.quality, quality + 0.05);
  }
  return { quality: Math.round(quality * 100) / 100, scale: Math.round(scale * 1000) / 1000 };
}
