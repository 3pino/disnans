import { describe, expect, it } from 'vitest';
import { APP_HEIGHT_VAR, isZoomKey, isZoomWheel, startViewportSync, startZoomGuard } from './viewport';

function fakeRoot() {
  const props = new Map<string, string>();
  return {
    props,
    style: {
      setProperty: (k: string, v: string) => props.set(k, v),
      removeProperty: (k: string) => props.delete(k),
    },
  } as unknown as HTMLElement & { props: Map<string, string> };
}

function fakeTarget() {
  const listeners = new Map<string, Set<(e: never) => void>>();
  return {
    listeners,
    addEventListener(type: string, l: (e: never) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(l);
    },
    removeEventListener(type: string, l: (e: never) => void) {
      listeners.get(type)?.delete(l);
    },
    fire(type: string, ev: object) {
      for (const l of listeners.get(type) ?? []) l(ev as never);
    },
    count(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

describe('拡大の判定', () => {
  it('Ctrl か Cmd を押したホイールだけを拡大とみなす', () => {
    expect(isZoomWheel({ ctrlKey: true, metaKey: false })).toBe(true);
    expect(isZoomWheel({ ctrlKey: false, metaKey: true })).toBe(true);
    expect(isZoomWheel({ ctrlKey: false, metaKey: false })).toBe(false);
  });

  it('Ctrl+± と Ctrl+0 だけを拡大のキーとみなす', () => {
    const k = (key: string, o: Partial<KeyboardEvent> = {}) => isZoomKey({ key, ctrlKey: true, metaKey: false, altKey: false, ...o });
    expect(k('+')).toBe(true);
    expect(k('=')).toBe(true);
    expect(k('-')).toBe(true);
    expect(k('0')).toBe(true);
    expect(k('Add')).toBe(true);
    expect(k('a')).toBe(false);
    expect(k('+', { ctrlKey: false })).toBe(false);
    expect(k('+', { altKey: true })).toBe(false);
    expect(k('+', { ctrlKey: false, metaKey: true })).toBe(true);
  });
});

describe('startViewportSync', () => {
  it('見えている高さを --app-height に入れ、変わったら入れ直す', () => {
    const root = fakeRoot();
    const vv = { height: 800, ...fakeTarget() };
    const w = { innerHeight: 900, ...fakeTarget() };
    const stop = startViewportSync(root, vv as never, w as never);
    expect(root.props.get(APP_HEIGHT_VAR)).toBe('800px');

    // キーボードが出て縮んだ
    vv.height = 512.4;
    vv.fire('resize', {});
    expect(root.props.get(APP_HEIGHT_VAR)).toBe('512px');

    stop();
    expect(root.props.has(APP_HEIGHT_VAR)).toBe(false);
    expect(vv.count('resize')).toBe(0);
    expect(w.count('resize')).toBe(0);
  });

  it('visualViewport がなければ window の高さを使う', () => {
    const root = fakeRoot();
    const w = { innerHeight: 700, ...fakeTarget() };
    const stop = startViewportSync(root, null, w as never);
    expect(root.props.get(APP_HEIGHT_VAR)).toBe('700px');
    stop();
  });
});

describe('startZoomGuard', () => {
  it('拡大の操作を止め、止めたら登録を外す', () => {
    const w = fakeTarget();
    const stop = startZoomGuard(w as never);
    let prevented = 0;
    const ev = (o: object) => ({ ...o, preventDefault: () => prevented++ });
    w.fire('wheel', ev({ ctrlKey: true, metaKey: false }));
    w.fire('wheel', ev({ ctrlKey: false, metaKey: false }));
    w.fire('keydown', ev({ key: '=', ctrlKey: true, metaKey: false, altKey: false }));
    w.fire('keydown', ev({ key: 'a', ctrlKey: true, metaKey: false, altKey: false }));
    expect(prevented).toBe(2);
    stop();
    expect(w.count('wheel')).toBe(0);
    expect(w.count('keydown')).toBe(0);
  });
});
