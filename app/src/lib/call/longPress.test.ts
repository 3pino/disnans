// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LONG_PRESS_MS, longPress } from './longPress';

function pointer(type: string, x = 0, y = 0, button = 0) {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button });
  return ev;
}

describe('longPress', () => {
  let node: HTMLButtonElement;
  const onLongPress = vi.fn();
  let action: ReturnType<typeof longPress>;
  beforeEach(() => {
    vi.useFakeTimers();
    onLongPress.mockClear();
    node = document.createElement('button');
    document.body.append(node);
    action = longPress(node, { onLongPress });
  });
  afterEach(() => {
    action.destroy();
    node.remove();
    vi.useRealTimers();
  });

  it('押し続けると長押しになり、その直後の click は打ち消される', () => {
    const click = vi.fn();
    node.addEventListener('click', click);
    node.dispatchEvent(pointer('pointerdown'));
    vi.advanceTimersByTime(LONG_PRESS_MS + 1);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    node.dispatchEvent(pointer('pointerup'));
    node.dispatchEvent(pointer('click'));
    expect(click).not.toHaveBeenCalled();
  });

  it('短く押しただけなら長押しにならず、click は通る', () => {
    const click = vi.fn();
    node.addEventListener('click', click);
    node.dispatchEvent(pointer('pointerdown'));
    vi.advanceTimersByTime(100);
    node.dispatchEvent(pointer('pointerup'));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    node.dispatchEvent(pointer('click'));
    expect(onLongPress).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('動かしたら（スクロールなど）長押しにならない', () => {
    node.dispatchEvent(pointer('pointerdown', 0, 0));
    node.dispatchEvent(pointer('pointermove', 30, 0));
    vi.advanceTimersByTime(LONG_PRESS_MS + 1);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('右クリック（contextmenu）でも長押しと同じ動作になり、長押しの直後の contextmenu は重ねて処理しない', () => {
    const ev = pointer('contextmenu', 0, 0, 2);
    node.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    onLongPress.mockClear();
    node.dispatchEvent(pointer('pointerdown'));
    vi.advanceTimersByTime(LONG_PRESS_MS + 1);
    node.dispatchEvent(pointer('contextmenu'));
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });
});
