import { describe, expect, it } from 'vitest';
import { isBackKey, startBackNav } from './backNav';

/** 戻る・進むを非同期の popstate で知らせる、履歴のまね */
function fakeHistory() {
  const entries: unknown[] = [null];
  let index = 0;
  const listeners = new Set<() => void>();
  const h = {
    get state() {
      return entries[index];
    },
    pushState(state: unknown) {
      entries.splice(index + 1);
      entries.push(state);
      index++;
    },
    go(n: number) {
      const to = index + n;
      if (to < 0 || to >= entries.length) return;
      queueMicrotask(() => {
        index = to;
        for (const l of listeners) l();
      });
    },
  };
  const w = {
    addEventListener: (_: string, l: () => void) => listeners.add(l),
    removeEventListener: (_: string, l: () => void) => listeners.delete(l),
  };
  return { h, w, length: () => entries.length, index: () => index };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('backNav', () => {
  it('戻るボタンで1つずつ戻る', async () => {
    const f = fakeHistory();
    // 開いた順に積む、簡単な履歴
    const stack: string[] = [];
    const nav = startBackNav({ depth: () => stack.length, back: () => stack.pop() !== undefined }, f.h as never, f.w as never);

    stack.push('settings');
    nav.sync();
    stack.push('sub');
    nav.sync();
    expect(f.index()).toBe(2);

    f.h.go(-1);
    await flush();
    expect(stack).toEqual(['settings']);
    f.h.go(-1);
    await flush();
    expect(stack).toEqual([]);
    expect(f.index()).toBe(0);
    nav.stop();
  });

  it('画面のボタンで戻ったら、その分だけ履歴を戻す', async () => {
    const f = fakeHistory();
    let n = 0;
    const back = () => (n > 0 ? (n--, true) : false);
    const nav = startBackNav({ depth: () => n, back }, f.h as never, f.w as never);
    n = 2;
    nav.sync();
    expect(f.index()).toBe(2);
    n = 0;
    nav.sync();
    // 戻っている最中に開いても、戻り終わってから積む
    n = 1;
    nav.sync();
    await flush();
    expect(n).toBe(1);
    expect(f.index()).toBe(1);
    nav.stop();
  });

  it('戻っても深さが減らない相手でも、回り続けない', async () => {
    const f = fakeHistory();
    let calls = 0;
    const nav = startBackNav({ depth: () => 1, back: () => (calls++, true) }, f.h as never, f.w as never);
    nav.sync();
    f.h.go(-1);
    await flush();
    expect(calls).toBeLessThanOrEqual(32);
    nav.stop();
  });
});

describe('isBackKey', () => {
  const k = (o: Partial<KeyboardEvent>) => isBackKey({ key: 'ArrowLeft', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, isComposing: false, ...o });
  it('Alt+← だけを戻る操作とみなす', () => {
    expect(k({})).toBe(true);
    expect(k({ key: 'ArrowRight' })).toBe(false);
    expect(k({ altKey: false })).toBe(false);
    expect(k({ ctrlKey: true })).toBe(false);
    expect(k({ shiftKey: true })).toBe(false);
    expect(k({ isComposing: true })).toBe(false);
  });
});
