<script lang="ts">
  import { clampView, containSize, doubleTapView, isDoubleTap, MIN_ZOOM, pinchView, wheelAction, zoomAt, type ViewState } from '../lib/call/screen/stage';

  // 画面の 1 枚を、その場で拡大・移動する舞台（通話の画面の中の埋め込み用）。
  // 全画面の表示（ScreenShareViewer）と同じ操作: Ctrl（Meta）+ ホイール・トラックパッドのピンチで拡大縮小、
  // 拡大中はドラッグ・ホイールで移動、2 本の指のピンチ、ダブルタップで拡大／元に戻す。
  // 埋め込みでは、等倍のときの修飾キーなしのホイールは拡大しない（ページのスクロールに譲る）。
  // 舞台そのものはボタンではない（押すと開く動作は持たない）。大きく見る操作は親が別に置く。
  let { src, alt, embedded = true }: { src: string; alt: string; embedded?: boolean } = $props();

  let view = $state<ViewState>({ scale: 1, x: 0, y: 0 });
  let natural = $state({ w: 0, h: 0 });
  let stageEl = $state<HTMLDivElement | undefined>(undefined);

  function stageSize(): { w: number; h: number } {
    return { w: stageEl?.clientWidth ?? 0, h: stageEl?.clientHeight ?? 0 };
  }
  function fit(v: ViewState): ViewState {
    const stage = stageSize();
    return clampView(v, stage, containSize(natural, stage));
  }
  function zoomTo(scale: number, p: { x: number; y: number }): void {
    view = fit(zoomAt(view, scale, p.x, p.y));
  }
  function rel(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = stageEl?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
  }

  function onLoad(e: Event): void {
    const img = e.currentTarget as HTMLImageElement;
    natural = { w: img.naturalWidth, h: img.naturalHeight };
    view = fit(view);
  }

  // 指・マウスの操作
  const pointers = new Map<number, { x: number; y: number }>();
  let gesture: { v0: ViewState; m0: { x: number; y: number }; d0: number } | null = null;
  let moved = false;
  let lastTap: { t: number; x: number; y: number } | null = null;

  function spread(): number {
    const [a, b] = [...pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }
  function middle(): { x: number; y: number } {
    const all = [...pointers.values()];
    return { x: all.reduce((s, p) => s + p.x, 0) / all.length, y: all.reduce((s, p) => s + p.y, 0) / all.length };
  }
  function restartGesture(): void {
    if (pointers.size === 0) gesture = null;
    else if (pointers.size === 1) gesture = { v0: view, m0: [...pointers.values()][0]!, d0: 1 };
    else gesture = { v0: view, m0: middle(), d0: spread() };
  }
  function onDown(e: PointerEvent): void {
    stageEl?.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, rel(e));
    if (pointers.size === 1) moved = false;
    restartGesture();
  }
  function onMove(e: PointerEvent): void {
    if (!pointers.has(e.pointerId)) return;
    const before = pointers.get(e.pointerId)!;
    const now = rel(e);
    pointers.set(e.pointerId, now);
    if (!gesture) return;
    if (Math.hypot(now.x - before.x, now.y - before.y) > 0) moved = true;
    if (pointers.size === 1) {
      view = fit(pinchView(gesture.v0, gesture.m0, 1, now, 1));
    } else if (pointers.size === 2 && gesture.d0 > 0) {
      view = fit(pinchView(gesture.v0, gesture.m0, gesture.d0, middle(), spread()));
    }
  }
  function onUp(e: PointerEvent): void {
    if (!pointers.has(e.pointerId)) return;
    const p = pointers.get(e.pointerId)!;
    const wasSingle = pointers.size === 1;
    pointers.delete(e.pointerId);
    if (wasSingle && !moved && e.type === 'pointerup') {
      const tap = { t: performance.now(), x: p.x, y: p.y };
      if (isDoubleTap(lastTap, tap)) {
        view = fit(doubleTapView(view, p));
        lastTap = null;
      } else {
        lastTap = tap;
      }
    }
    restartGesture();
  }

  // ホイール: ページを止めるため passive を外す（操作にならないときは何もしない）
  function wheel(node: HTMLElement) {
    const fn = (e: WheelEvent) => {
      const a = wheelAction(e, { scale: view.scale, embedded, pageHeight: node.clientHeight });
      if (!a) return;
      e.preventDefault();
      if (a.kind === 'zoom') zoomTo(view.scale * a.factor, rel(e));
      else view = fit({ ...view, x: view.x - a.dx, y: view.y - a.dy });
    };
    node.addEventListener('wheel', fn, { passive: false });
    return { destroy: () => node.removeEventListener('wheel', fn) };
  }

  // 等倍に戻したら、移動の印も消す
  $effect(() => {
    if (view.scale <= MIN_ZOOM + 1e-6 && (view.x !== 0 || view.y !== 0)) view = { scale: MIN_ZOOM, x: 0, y: 0 };
  });
</script>

<div
  class="screen-stage"
  class:screen-stage-zoomed={view.scale > MIN_ZOOM + 1e-6}
  bind:this={stageEl}
  use:wheel
  onpointerdown={onDown}
  onpointermove={onMove}
  onpointerup={onUp}
  onpointercancel={onUp}
  role="presentation"
  data-testid="screen-stage"
>
  <img
    class="screen-stage-image"
    {src}
    {alt}
    draggable="false"
    style:transform={`translate(${view.x}px, ${view.y}px) scale(${view.scale})`}
    onload={onLoad}
  />
</div>

<style>
  .screen-stage {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    max-height: 60vh;
    overflow: hidden;
    /* ピンチの開始時から OS の縦スクロールに奪わせない。倍率が変わってから none にしても、そのジェスチャーには間に合わない。 */
    touch-action: none;
    user-select: none;
  }
  .screen-stage-zoomed {
    touch-action: none;
    cursor: grab;
  }
  .screen-stage-image {
    display: block;
    max-width: 100%;
    max-height: 60vh;
    object-fit: contain;
    transform-origin: center center;
  }
</style>
