/**
 * 画面が変わったかの判定（純粋な関数）。
 */
import { KEEPALIVE_FRAME_MS } from './pacing';

/** 縮小画像の 1 色あたりの差の平均がこれ以下なら「変わっていない」（0〜255） */
export const DIFF_THRESHOLD = 1.5;
/** 1 画素の RGB の平均の差がこれを超えたら「変わった」 */
export const PEAK_THRESHOLD = 24;

/** 2 枚の縮小画像（RGBA）の、1 色あたりの絶対差の平均（透明度は見ない） */
export function frameDiff(a: ArrayLike<number> | null, b: ArrayLike<number> | null): number {
  if (!a || !b || a.length !== b.length) return Infinity;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue;
    sum += Math.abs(a[i] - b[i]);
    n++;
  }
  return n === 0 ? 0 : sum / n;
}

/** 2 枚の縮小画像（RGBA）で、いちばん変わった画素の RGB の平均の差 */
export function framePeakDiff(a: ArrayLike<number> | null, b: ArrayLike<number> | null): number {
  if (!a || !b || a.length !== b.length) return Infinity;
  let peak = 0;
  for (let i = 0; i + 3 < a.length; i += 4) {
    const d = (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
    if (d > peak) peak = d;
  }
  return peak;
}

/** 全部透明の画像か（映像がまだ来ていない・描けない環境で起きる） */
export function isBlankFrame(data: ArrayLike<number>): boolean {
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return false;
  return true;
}

/** フレームを送るか（変わったとき・強制・送ってから十分たったとき） */
export function shouldSend(o: { diff: number; peak?: number; sinceSentMs: number; force: boolean }): boolean {
  return o.force || o.diff > DIFF_THRESHOLD || (o.peak ?? 0) > PEAK_THRESHOLD || o.sinceSentMs >= KEEPALIVE_FRAME_MS;
}
