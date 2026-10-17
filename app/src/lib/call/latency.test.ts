import { describe, expect, it } from 'vitest';
import { LATENCY_REPORT_MS, LatencyStats, clockText } from './latency';

describe('通話の音声の遅れの集計', () => {
  it('間隔が過ぎるまで報告しない。過ぎたら平均・最大・件数をまとめて、集計を捨てる', () => {
    const s = new LatencyStats();
    s.reset(0);
    s.add('送信の往復', 10);
    s.add('送信の往復', 30);
    s.count('捨てた音声', 2);
    s.gauge('同時に送信中', 3);
    s.gauge('同時に送信中', 1);
    s.fail('busy');
    expect(s.report(LATENCY_REPORT_MS - 1)).toBeNull();
    const text = s.report(LATENCY_REPORT_MS)!;
    expect(text).toContain('送信の往復(avg/max)=20.0/30.0ms n=2');
    expect(text).toContain('捨てた音声=2');
    expect(text).toContain('同時に送信中最大=3');
    expect(text).toContain('fail:busy=1');
    // 捨てたあとは空（次の間隔で何も無ければ null）
    expect(s.report(LATENCY_REPORT_MS * 2)).toBeNull();
  });

  it('何も記録しなかった間隔は null（間隔だけ進める）', () => {
    const s = new LatencyStats();
    s.reset(0);
    expect(s.report(LATENCY_REPORT_MS)).toBeNull();
    s.add('x', 1);
    expect(s.report(LATENCY_REPORT_MS + 1)).toBeNull();
  });
});

describe('通話の時計のずれ', () => {
  it('壁の時計と ctx の時計と受けた音の数の差を、開始からの値で出す', () => {
    const text = clockText({ ctx: 10, wall: 1000, frames: 0 }, { ctx: 15, wall: 6000, frames: 48000 * 4 }, 48000);
    expect(text).toContain('実経過=5.0s');
    expect(text).toContain('ctx経過=5.0s');
    expect(text).toContain('ずれ(ctx-実)=0ms');
    expect(text).toContain('受けた音=4.00s分');
    expect(text).toContain('差(受け-ctx)=-1000ms');
  });

  it('ctx が壁より遅れると、ずれは負になる', () => {
    const text = clockText({ ctx: 0, wall: 0, frames: 0 }, { ctx: 4.5, wall: 5000, frames: 0 }, 48000);
    expect(text).toContain('ずれ(ctx-実)=-500ms');
  });
});
