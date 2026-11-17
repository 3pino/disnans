// 本文のファイルリンクの「開く」の口: 1 つだけ。後から登録したものが勝ち、外すのは自分のものだけ
import { describe, expect, it, vi } from 'vitest';
import { linkOpener, setLinkOpener } from './linkOpener.svelte';

describe('linkOpener', () => {
  it('登録が無ければ null（本体の既定）', () => {
    expect(linkOpener()).toBeNull();
  });

  it('登録すると使える。後から登録したものが勝つ。外すと、自分のものだけ空にする', () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = setLinkOpener(a);
    const offB = setLinkOpener(b);
    expect(linkOpener()).toBe(b);
    offA(); // 前のものの解除は、いまのものを消さない
    expect(linkOpener()).toBe(b);
    offB();
    expect(linkOpener()).toBeNull();
  });
});
