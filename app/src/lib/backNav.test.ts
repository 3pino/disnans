import { describe, expect, it } from 'vitest';
import { closeTopLayer, isBackKey, startBackNav } from './backNav';

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
  it('戻るボタンで上の層から1つずつ閉じる', async () => {
    const f = fakeHistory();
    const open = { tab: false, sub: false, panel: false };
    const layers = () => {
      const ls: (() => void)[] = [];
      if (open.tab)
        ls.push(() => {
          open.tab = false;
          open.sub = false;
        });
      if (open.tab && open.sub) ls.push(() => (open.sub = false));
      if (open.panel) ls.push(() => (open.panel = false));
      return ls;
    };
    const nav = startBackNav(layers, f.h as never, f.w as never);

    open.tab = true;
    nav.sync();
    open.sub = true;
    nav.sync();
    expect(f.index()).toBe(2);

    f.h.go(-1);
    await flush();
    expect(open).toEqual({ tab: true, sub: false, panel: false });
    f.h.go(-1);
    await flush();
    expect(open).toEqual({ tab: false, sub: false, panel: false });
    expect(f.index()).toBe(0);
    nav.stop();
  });

  it('画面のボタンで閉じたら、その分だけ履歴を戻す', async () => {
    const f = fakeHistory();
    let n = 0;
    const nav = startBackNav(() => Array.from({ length: n }, () => () => n--), f.h as never, f.w as never);
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

describe('closeTopLayer', () => {
  it('上の層から1つだけ閉じる。層がなければ false', () => {
    const log: string[] = [];
    expect(closeTopLayer([])).toBe(false);
    expect(closeTopLayer([() => log.push('tab'), () => log.push('panel')])).toBe(true);
    expect(log).toEqual(['panel']);
  });
});
