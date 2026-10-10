// 長押し（PC は右クリックでもよい）の Svelte action。長押しが成立したあとの click は打ち消す。
// 指やマウスが動いたら（スクロールなど）長押しではない

export const LONG_PRESS_MS = 500;
/** この距離（px）以上動いたら長押しをやめる */
export const LONG_PRESS_MOVE = 10;

export type LongPressOptions = { onLongPress: () => void; ms?: number };

export function longPress(node: HTMLElement, initial: LongPressOptions) {
  let opts = initial;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let startX = 0;
  let startY = 0;
  /** 長押しが成立した時刻。直後の click と contextmenu を打ち消す */
  let firedAt = -Infinity;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const fire = () => {
    clear();
    firedAt = Date.now();
    opts.onLongPress();
  };
  const down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    clear();
    startX = e.clientX;
    startY = e.clientY;
    timer = setTimeout(fire, opts.ms ?? LONG_PRESS_MS);
  };
  const move = (e: PointerEvent) => {
    if (timer && Math.hypot(e.clientX - startX, e.clientY - startY) > LONG_PRESS_MOVE) clear();
  };
  const click = (e: MouseEvent) => {
    if (Date.now() - firedAt < 400) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };
  const menu = (e: MouseEvent) => {
    e.preventDefault();
    // 長押しの直後に来る contextmenu（Android）は、すでに処理済み
    if (Date.now() - firedAt < 800) return;
    fire();
  };

  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', clear);
  node.addEventListener('pointercancel', clear);
  node.addEventListener('pointerleave', clear);
  node.addEventListener('click', click, true);
  node.addEventListener('contextmenu', menu);
  return {
    update(next: LongPressOptions) {
      opts = next;
    },
    destroy() {
      clear();
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', clear);
      node.removeEventListener('pointercancel', clear);
      node.removeEventListener('pointerleave', clear);
      node.removeEventListener('click', click, true);
      node.removeEventListener('contextmenu', menu);
    },
  };
}
