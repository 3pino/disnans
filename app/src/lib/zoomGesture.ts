// 拡大表示のビューアー（画像・PDF など。components/viewers/）が共通で使う、指・マウスの操作の受け口（Svelte の action）。
// 受けるのは「ピンチ（2 本指）・1 本指の移動・タップ／ダブルタップ・Ctrl+ホイール（トラックパッドのピンチ）」。
// 倍率や位置の計算は、受け取った側（ビューアー）が持つ。
// - タッチは Touch Events で受ける（2 本指の touchmove を止めて、ブラウザーのスクロール・拡大に取られないようにするため。
//   Pointer Events は、ブラウザーがスクロールを始めると pointercancel で切れる）
// - マウスは Pointer Events（ドラッグで移動、ダブルクリックで拡大）
// - Ctrl+ホイールは、Windows・macOS のトラックパッドのピンチもこれで届く。小さい量が続けて届くので、量に比例して拡大する

import { isDoubleTap, type Point, type TapRecord } from './zoom';

/** いまの指（マウス）の様子。mid は中点、dist は 2 本指の間隔（1 本なら 0）、count は指の数。位置は要素の左上から */
export type GestureFrame = { mid: Point; dist: number; count: number };

export type ZoomGestureOptions = {
  /** 指の数が変わった（触れた・離した）ときの、新しい始まり。move はこの frame からの変化で呼ぶ */
  start?(frame: GestureFrame): void;
  /** 動いた。first はいまの指の数になったときの様子 */
  move?(first: GestureFrame, now: GestureFrame): void;
  /** 指がすべて離れた（動かしていなければ、続けて tap も呼ぶ） */
  end?(): void;
  /** 動かさずに離した。double はダブルタップ（ダブルクリック） */
  tap?(p: Point, double: boolean): void;
  /** Ctrl+ホイール。factor は倍率の掛け算（1 より大きいと拡大） */
  wheel?(factor: number, p: Point): void;
  /**
   * 1 本指の動きをこちらで受けるか（受けるとブラウザーのスクロールと、拡大表示の左右のスワイプは起きない）。
   * 省略すると受けない。2 本指は常に受ける
   */
  panOne?(): boolean;
};

/** 動かしたとみなす距離（px） */
const TAP_SLOP = 8;
/** Ctrl+ホイールの 1px あたりの拡大率の変化（lib/zoom.ts の zoomByWheel と同じ） */
const WHEEL_SENSITIVITY = 0.005;

/** WheelEvent の deltaY を px にそろえる（行・ページ単位で来る環境がある） */
export function wheelPixels(e: Pick<WheelEvent, 'deltaY' | 'deltaMode'>): number {
  if (e.deltaMode === 1) return e.deltaY * 16;
  if (e.deltaMode === 2) return e.deltaY * 400;
  return e.deltaY;
}

/** Ctrl+ホイール 1 回の倍率の掛け算 */
export function wheelFactor(e: Pick<WheelEvent, 'deltaY' | 'deltaMode'>): number {
  // 1 回で極端に動かない（マウスのホイールの 1 段は 100px ほど）
  const px = Math.max(-200, Math.min(200, wheelPixels(e)));
  return Math.exp(-px * WHEEL_SENSITIVITY);
}

export function zoomGesture(node: HTMLElement, initial: ZoomGestureOptions) {
  let opts = initial;
  /** いまの指の位置（要素の左上から）。identifier / pointerId ごと */
  const points = new Map<number, Point>();
  let first: GestureFrame | null = null;
  let tapFrom: Point | null = null;
  let lastTap: TapRecord | null = null;
  /** このジェスチャーで 2 本指になったか（なったら、離してもタップにしない） */
  let multi = false;

  function local(p: { clientX: number; clientY: number }): Point {
    const r = node.getBoundingClientRect();
    return { x: p.clientX - r.left, y: p.clientY - r.top };
  }

  function frame(): GestureFrame {
    const pts = [...points.values()].slice(0, 2);
    const a = pts[0];
    const b = pts[pts.length - 1];
    return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: pts.length > 1 ? Math.hypot(a.x - b.x, a.y - b.y) : 0, count: points.size };
  }

  function restart(): void {
    first = frame();
    opts.start?.(first);
  }

  function down(id: number, p: Point): void {
    if (points.size === 0) {
      multi = false;
      tapFrom = p;
    }
    points.set(id, p);
    if (points.size > 1) {
      multi = true;
      tapFrom = null;
    }
    restart();
  }

  /** 動いた。返り値は、この動きをこちらで受けたか（受けたらブラウザーの既定の動きを止める） */
  function moved(id: number, p: Point): boolean {
    if (!points.has(id) || !first) return false;
    points.set(id, p);
    if (tapFrom && Math.hypot(p.x - tapFrom.x, p.y - tapFrom.y) > TAP_SLOP) tapFrom = null;
    if (points.size < 2 && !opts.panOne?.()) return false;
    opts.move?.(first, frame());
    return true;
  }

  function up(id: number, p: Point | null): void {
    if (!points.delete(id)) return;
    if (points.size > 0) {
      restart();
      return;
    }
    first = null;
    opts.end?.();
    const from = tapFrom;
    tapFrom = null;
    if (!from || multi || !p) return;
    const tap = { t: Date.now(), x: p.x, y: p.y };
    const double = isDoubleTap(lastTap, tap);
    lastTap = double ? null : tap;
    opts.tap?.(p, double);
  }

  // ---- タッチ ----
  function onTouchStart(e: TouchEvent): void {
    for (const t of e.changedTouches) down(t.identifier, local(t));
  }
  function onTouchMove(e: TouchEvent): void {
    let took = false;
    for (const t of e.changedTouches) took = moved(t.identifier, local(t)) || took;
    if (took && e.cancelable) e.preventDefault();
  }
  function onTouchEnd(e: TouchEvent): void {
    for (const t of e.changedTouches) up(t.identifier, e.type === 'touchend' ? local(t) : null);
  }

  // ---- マウス（タッチ・ペンは Touch Events の側で受ける） ----
  function onPointerDown(e: PointerEvent): void {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    if (e.target instanceof Element && e.target.closest('button, a, input')) return;
    try {
      node.setPointerCapture(e.pointerId);
    } catch {
      // 取れなくても動く
    }
    down(e.pointerId, local(e));
  }
  function onPointerMove(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && moved(e.pointerId, local(e))) e.preventDefault();
  }
  function onPointerUp(e: PointerEvent): void {
    if (e.pointerType !== 'mouse') return;
    up(e.pointerId, e.type === 'pointerup' ? local(e) : null);
  }

  function onWheel(e: WheelEvent): void {
    if (!e.ctrlKey || !opts.wheel) return;
    // WebView 自体のズームは止める
    e.preventDefault();
    opts.wheel(wheelFactor(e), local(e));
  }

  node.addEventListener('touchstart', onTouchStart, { passive: true });
  node.addEventListener('touchmove', onTouchMove, { passive: false });
  node.addEventListener('touchend', onTouchEnd);
  node.addEventListener('touchcancel', onTouchEnd);
  node.addEventListener('pointerdown', onPointerDown);
  node.addEventListener('pointermove', onPointerMove);
  node.addEventListener('pointerup', onPointerUp);
  node.addEventListener('pointercancel', onPointerUp);
  node.addEventListener('wheel', onWheel, { passive: false });

  return {
    update(next: ZoomGestureOptions) {
      opts = next;
    },
    destroy() {
      node.removeEventListener('touchstart', onTouchStart);
      node.removeEventListener('touchmove', onTouchMove);
      node.removeEventListener('touchend', onTouchEnd);
      node.removeEventListener('touchcancel', onTouchEnd);
      node.removeEventListener('pointerdown', onPointerDown);
      node.removeEventListener('pointermove', onPointerMove);
      node.removeEventListener('pointerup', onPointerUp);
      node.removeEventListener('pointercancel', onPointerUp);
      node.removeEventListener('wheel', onWheel);
    },
  };
}
