import { describe, expect, it } from 'vitest';
import { NativeGate, isLive, mirrorOf, newSessionToken } from './native';
import { snap } from './nativeFake';

describe('NativeGate（古い状態・出来事を捨てる）', () => {
  it('同じ世代では、seq が増えたものだけ通す', () => {
    const g = new NativeGate();
    expect(g.accept({ generation: 1, seq: 0 })).toBe(true);
    expect(g.accept({ generation: 1, seq: 0 })).toBe(false);
    expect(g.accept({ generation: 1, seq: 2 })).toBe(true);
    expect(g.accept({ generation: 1, seq: 1 })).toBe(false);
  });

  it('古い世代は、新しい seq でも捨てる。新しい世代は、seq が 0 からでも採用する（再起動の回復）', () => {
    const g = new NativeGate();
    expect(g.accept({ generation: 2, seq: 5 })).toBe(true);
    expect(g.accept({ generation: 1, seq: 99 })).toBe(false);
    expect(g.accept({ generation: 3, seq: 0 })).toBe(true);
  });
});

describe('newSessionToken（参加を頼む前に作る論理セッション）', () => {
  it('ASCII で 48 文字以内、呼ぶたびに違う', () => {
    const a = newSessionToken();
    const b = newSessionToken();
    expect(a).not.toBe(b);
    for (const t of [a, b]) {
      expect(t.length).toBeGreaterThan(0);
      expect(t.length).toBeLessThanOrEqual(48);
      expect(/^[\x21-\x7e]+$/.test(t)).toBe(true);
    }
  });
});

describe('mirrorOf / isLive（画面へ写す。判断は持たない）', () => {
  it('参加中・回復中は joined、参加の途中は joining、止まっているものは何も無い', () => {
    expect(mirrorOf(snap({ phase: 'joined', listed: true, peer: 'p' })).joined).toBe(true);
    expect(mirrorOf(snap({ phase: 'recovering', listed: false, peer: 'p' })).joined).toBe(true);
    expect(mirrorOf(snap({ phase: 'joining' })).joining).toBe(true);
    expect(mirrorOf(snap({ phase: 'joining' })).joined).toBe(false);
    expect(mirrorOf(snap({ phase: 'stopping' })).joined).toBe(false);
    expect(mirrorOf(snap({ phase: 'idle' })).joined).toBe(false);
  });

  it('listed は、参加中で、かつサーバーの一覧に載ったときだけ。linkDown は参加中に接続が無いとき', () => {
    expect(mirrorOf(snap({ phase: 'joining', listed: true })).listed).toBe(false);
    expect(mirrorOf(snap({ phase: 'joined', listed: true })).listed).toBe(true);
    expect(mirrorOf(snap({ phase: 'idle', linkUp: false })).linkDown).toBe(false);
    expect(mirrorOf(snap({ phase: 'recovering', linkUp: false })).linkDown).toBe(true);
  });

  it('isLive は joining / joined / recovering', () => {
    expect(isLive('joining')).toBe(true);
    expect(isLive('joined')).toBe(true);
    expect(isLive('recovering')).toBe(true);
    expect(isLive('idle')).toBe(false);
    expect(isLive('stopping')).toBe(false);
  });
});
