// @vitest-environment jsdom
// 拡大の止め（startZoomGuard）と、拡大表示の受け口（zoomGesture）が一緒に働くこと。
// WebView2 の拡大（zoomHotkeysEnabled）を Windows で許すので、ページ全体が拡大しないことと、ビューアーの拡大が残ることを確かめる。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startZoomGuard } from './viewport';
import { zoomGesture, wheelFactor } from './zoomGesture';

let stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
  document.body.innerHTML = '';
});

function wheel(target: EventTarget, init: WheelEventInit): WheelEvent {
  const ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -40, ...init });
  target.dispatchEvent(ev);
  return ev;
}

function key(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(ev);
  return ev;
}

/** 拡大表示（viewer）と、その外の本文（page）を作る。viewer の中で ctrl+wheel を受けると wheel() が呼ばれる */
function setup() {
  const stage = document.createElement('div');
  const inner = document.createElement('img');
  stage.appendChild(inner);
  const page = document.createElement('p');
  document.body.append(stage, page);
  const wheelFn = vi.fn();
  stops.push(zoomGesture(stage, { wheel: wheelFn }).destroy);
  stops.push(startZoomGuard(window));
  return { stage, inner, page, wheelFn };
}

describe('ページの拡大の止め（Ctrl+ホイール）', () => {
  it('ビューアーの中の Ctrl+ホイールは、ビューアーの拡大に届き、ページの拡大は止まる', () => {
    const { inner, wheelFn } = setup();
    const ev = wheel(inner, { ctrlKey: true, deltaY: -40 });
    expect(ev.defaultPrevented).toBe(true);
    expect(wheelFn).toHaveBeenCalledTimes(1);
    const [factor] = wheelFn.mock.calls[0];
    expect(factor).toBeCloseTo(wheelFactor({ deltaY: -40, deltaMode: 0 }));
    expect(factor).toBeGreaterThan(1);
  });

  it('ビューアーの外（本文）の Ctrl+ホイールも止める（ページは拡大しない）', () => {
    const { page, wheelFn } = setup();
    const ev = wheel(page, { ctrlKey: true, deltaY: -40 });
    expect(ev.defaultPrevented).toBe(true);
    expect(wheelFn).not.toHaveBeenCalled();
  });

  it('Ctrl のないホイールは止めない（本文のスクロールはそのまま）', () => {
    const { inner, page, wheelFn } = setup();
    expect(wheel(page, { ctrlKey: false }).defaultPrevented).toBe(false);
    expect(wheel(inner, { ctrlKey: false }).defaultPrevented).toBe(false);
    expect(wheelFn).not.toHaveBeenCalled();
  });

  it('止めを外すと、本文の Ctrl+ホイールは既定の動きに戻る（この関数だけの効果）', () => {
    const page = document.createElement('p');
    document.body.appendChild(page);
    const stop = startZoomGuard(window);
    expect(wheel(page, { ctrlKey: true }).defaultPrevented).toBe(true);
    stop();
    expect(wheel(page, { ctrlKey: true }).defaultPrevented).toBe(false);
  });
});

describe('ページの拡大の止め（Ctrl+± / Ctrl+0）', () => {
  it('Ctrl+ + - = 0 は止め、ほかの Ctrl のキーは止めない', () => {
    setup();
    for (const k of ['+', '=', '-', '0', 'Add', 'Subtract']) {
      expect(key(document.body, { key: k, ctrlKey: true }).defaultPrevented, k).toBe(true);
    }
    expect(key(document.body, { key: 'c', ctrlKey: true }).defaultPrevented).toBe(false);
    expect(key(document.body, { key: '+', ctrlKey: false }).defaultPrevented).toBe(false);
  });

  it('Ctrl+Alt の組み合わせは止めない（別の操作として残す）', () => {
    setup();
    expect(key(document.body, { key: '+', ctrlKey: true, altKey: true }).defaultPrevented).toBe(false);
  });

  it('Ctrl+Shift+I（開発者ツール）は止めない', () => {
    setup();
    expect(key(document.body, { key: 'I', ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
  });

  it('拡大表示の中のキー（矢印・Esc）は、この止めの影響を受けない', () => {
    setup();
    expect(key(document.body, { key: 'ArrowLeft' }).defaultPrevented).toBe(false);
    expect(key(document.body, { key: 'Escape' }).defaultPrevented).toBe(false);
  });
});
