import { describe, expect, it } from 'vitest';
import { LATENCY_REPORT_MS, LatencyStats } from './latency';

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
