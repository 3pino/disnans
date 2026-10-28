import { describe, expect, it } from 'vitest';
import { AudioDiag, DIAG_MS, countsText, describeTrack, type DiagState } from './audioDiag';

const state: DiagState = {
  joined: true,
  listed: true,
  others: 0,
  muted: false,
  deafened: false,
  ctxState: 'running',
  ctxTime: 5.5,
  outTime: null,
  capture: false,
  track: 'live muted=false enabled=true',
  entries: 0,
};

describe('通話の音声の診断（数の集計と 1 行）', () => {
  it('要約は間隔ごとに出て、差分は前回の要約からの増えた数', () => {
    const d = new AudioDiag();
    d.reset(0);
    d.add('sendTry', 3);
    expect(d.due(DIAG_MS - 1)).toBe(false);
    expect(d.due(DIAG_MS)).toBe(true);
    const first = d.summary(DIAG_MS, state);
    expect(first).toContain('前回から=5s');
    expect(first).toContain('送信試行=3');
    expect(first).not.toContain('(+');
    d.add('sendTry', 2);
    expect(d.due(DIAG_MS)).toBe(false);
    const second = d.summary(DIAG_MS * 2, state);
    expect(second).toContain('送信試行=5(+2)');
  });

  it('相手がいない・取り込みが無いことを、状態の行に出す（参加者数と取込の有無）', () => {
    const d = new AudioDiag();
    d.reset(0);
    const text = d.summary(DIAG_MS, state);
    expect(text).toContain('相手=0');
    expect(text).toContain('取込=off');
    expect(text).toContain('参加=yes');
    expect(text).toContain('一覧=yes');
    expect(text).toContain('(なし)');
  });

  it('JS が止まっていた間隔は、次の要約で「間隔が長い」と分かる', () => {
    const d = new AudioDiag();
    d.reset(0);
    d.summary(DIAG_MS, state);
    // 要約が出ない 30 秒のあと
    const late = d.summary(DIAG_MS + 30000, state);
    expect(late).toContain('間隔が長い');
    expect(late).toContain('前回から=30s');
  });

  it('即時の行は累計だけを書き、差分の基準を動かさない', () => {
    const d = new AudioDiag();
    d.reset(0);
    d.add('recv', 4);
    const now = d.immediate(2000, '背景', state);
    expect(now).toContain('診断 背景');
    expect(now).toContain('受信音声=4');
    expect(now).not.toContain('(+');
    d.add('recv', 1);
    // 基準は最初の要約で決まるので、最初の要約は累計だけ
    expect(d.summary(DIAG_MS, state)).toMatch(/受信音声=5$/);
    expect(d.summary(DIAG_MS * 2, state)).toContain('受信音声=5(+0)');
  });

  it('reset で累計も基準も捨てる', () => {
    const d = new AudioDiag();
    d.reset(0);
    d.add('play', 9);
    d.summary(DIAG_MS, state);
    d.reset(10000);
    expect(d.get('play')).toBe(0);
    expect(d.due(10000 + DIAG_MS - 1)).toBe(false);
    expect(d.summary(10000 + DIAG_MS, state)).toContain('(なし)');
  });

  it('ゼロの項目は出さず、ラベル付きで並べる', () => {
    const cur = new Map([
      ['capCb', 2],
      ['micEvent.mute', 1],
      ['recvDrop.muted', 0],
    ]);
    expect(countsText(cur, null)).toBe('取込=2 マイクmute=1');
    expect(countsText(new Map(), null)).toBe('(なし)');
  });

  it('track の状態は readyState・muted・enabled だけ（ID は書かない）', () => {
    expect(describeTrack(undefined)).toBe('なし');
    expect(describeTrack({ readyState: 'live', muted: false, enabled: true })).toBe('live muted=false enabled=true');
    expect(describeTrack({})).toBe('? muted=? enabled=?');
  });
});
