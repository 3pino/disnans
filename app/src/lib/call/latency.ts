// 通話の音声の遅れの診断。Console に一定間隔でまとめて出す（音の中身や通信の中身は出さない）

/** Rust 経路で、まだ返事の来ていない音声（call.emit）の上限。これを超えたら新しいほうを捨てる（遅れて届くより捨てる） */
export const AUDIO_MAX_IN_FLIGHT = 8;
/** 集計を Console に出す間隔 */
export const LATENCY_REPORT_MS = 5000;

type Acc = { n: number; sum: number; max: number };

export class LatencyStats {
  private acc = new Map<string, Acc>();
  private counts = new Map<string, number>();
  private gauges = new Map<string, number>();
  private since = 0;

  /** 集計を始める（参加したとき） */
  reset(now: number): void {
    this.acc.clear();
    this.counts.clear();
    this.gauges.clear();
    this.since = now;
  }

  /** ms の値を足す（平均と最大を出す） */
  add(name: string, ms: number): void {
    const a = this.acc.get(name) ?? { n: 0, sum: 0, max: 0 };
    a.n += 1;
    a.sum += ms;
    if (ms > a.max) a.max = ms;
    this.acc.set(name, a);
  }

  count(name: string, n = 1): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + n);
  }

  /** 最大値だけ覚える（同時に送っている数など） */
  gauge(name: string, v: number): void {
    if (v > (this.gauges.get(name) ?? 0)) this.gauges.set(name, v);
  }

  /** 送れなかった理由（code）ごとに数える */
  fail(code: string): void {
    this.count(`fail:${code}`);
  }

  /** 間隔が過ぎていれば、まとめた文字列を返して集計を捨てる。何も無ければ null（間隔は進める） */
  report(now: number): string | null {
    if (now - this.since < LATENCY_REPORT_MS) return null;
    const parts: string[] = [];
    for (const [k, a] of this.acc) parts.push(`${k}(avg/max)=${(a.sum / a.n).toFixed(1)}/${a.max.toFixed(1)}ms n=${a.n}`);
    for (const [k, v] of this.counts) parts.push(`${k}=${v}`);
    for (const [k, v] of this.gauges) parts.push(`${k}最大=${v}`);
    const text = parts.length > 0 ? `${Math.round(now - this.since)}ms間: ${parts.join(' ')}` : null;
    this.reset(now);
    return text;
  }
}

/** 時計の比べ方の一点（ctx の時刻・壁の時刻 ms・受けた音のフレーム数） */
export type ClockPoint = { ctx: number; wall: number; frames: number };

/**
 * AudioContext の時計と、壁の時計と、受けたフレームの数を比べる（開始からの差）。
 * ずれ(ctx-実) が負なら ctx が実時間より遅い（CPU 飽和・underrun）。差(フレーム-ctx) が負なら受けた音が足りない（落ちた）
 */
export function clockText(start: ClockPoint, now: ClockPoint, rate: number): string {
  const wallSec = (now.wall - start.wall) / 1000;
  const ctxSec = now.ctx - start.ctx;
  const framesSec = (now.frames - start.frames) / rate;
  const drift = (ctxSec - wallSec) * 1000;
  const gap = (framesSec - ctxSec) * 1000;
  return `実経過=${wallSec.toFixed(1)}s ctx経過=${ctxSec.toFixed(1)}s ずれ(ctx-実)=${drift.toFixed(0)}ms 受けた音=${framesSec.toFixed(2)}s分 差(受け-ctx)=${gap.toFixed(0)}ms`;
}

/** 通話の音声の診断の集計（1 つだけ。通話は同時に 1 つ） */
export const callLatency = new LatencyStats();
