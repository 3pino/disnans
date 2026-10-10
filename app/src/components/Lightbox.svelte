<script lang="ts">
  import X from '@lucide/svelte/icons/x';
  import Download from '@lucide/svelte/icons/download';
  import IconButton from './ui/IconButton.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import {
    DOUBLE_TAP_ZOOM,
    IDENTITY_VIEW,
    MIN_ZOOM,
    clampView,
    isDoubleTap,
    pinchView,
    zoomAt,
    zoomByWheel,
    type Point,
    type TapRecord,
    type ZoomView,
  } from '../lib/zoom';

  /** 1 本指の動きがこれより小さければタップとみなす（px） */
  const TAP_SLOP = 8;
  /** 背景タップで閉じるまでの待ち時間（ダブルタップと区別するため） */
  const CLOSE_DELAY = 300;

  let view = $state<ZoomView>({ ...IDENTITY_VIEW });
  let stageEl = $state<HTMLDivElement>();
  let imgEl = $state<HTMLImageElement>();
  const transform = $derived(`translate(${view.x}px, ${view.y}px) scale(${view.scale})`);

  /** 指の位置（舞台の中心からの位置）。pointerId ごと */
  const pointers = new Map<number, Point>();
  /** いまのジェスチャーの始まり（指の数が変わるたびに作り直す） */
  let start: { view: ZoomView; mid: Point; dist: number; tap: Point } | null = null;
  /** このジェスチャーで、タップ（動かさず 1 本指で触れた）ではなくなったか */
  let moved = false;
  let lastTap: TapRecord | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  /** 舞台（全画面）の中心を原点にした座標 */
  function local(e: { clientX: number; clientY: number }): Point {
    const r = stageEl?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: e.clientX - (r.left + r.width / 2), y: e.clientY - (r.top + r.height / 2) };
  }

  /** 表示を、舞台と画像の大きさに合わせて収める */
  function fit(v: ZoomView): ZoomView {
    const stage = { w: stageEl?.clientWidth ?? 0, h: stageEl?.clientHeight ?? 0 };
    const img = { w: imgEl?.offsetWidth ?? 0, h: imgEl?.offsetHeight ?? 0 };
    return clampView(v, stage, img);
  }

  /** 指の中点と間隔（指が 2 本未満なら間隔は 0） */
  function geometry(): { mid: Point; dist: number } {
    const pts = [...pointers.values()].slice(0, 2);
    const mid = { x: (pts[0].x + pts[pts.length - 1].x) / 2, y: (pts[0].y + pts[pts.length - 1].y) / 2 };
    const dist = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    return { mid, dist };
  }

  /** 指の数が変わったら、いまの表示と指の位置から始め直す */
  function restart(first: Point) {
    const g = geometry();
    start = { view, mid: g.mid, dist: g.dist, tap: first };
  }

  function onPointerDown(e: PointerEvent) {
    if (!stageEl || e.button !== 0) return;
    try {
      stageEl.setPointerCapture(e.pointerId);
    } catch {
      // 取れなくても動く
    }
    clearTimeout(closeTimer);
    const p = local(e);
    if (pointers.size === 0) moved = false;
    pointers.set(e.pointerId, p);
    if (pointers.size > 1) moved = true;
    restart(p);
  }

  function onPointerMove(e: PointerEvent) {
    if (!pointers.has(e.pointerId) || !start) return;
    const p = local(e);
    pointers.set(e.pointerId, p);
    if (pointers.size > 1 || Math.hypot(p.x - start.tap.x, p.y - start.tap.y) > TAP_SLOP) moved = true;
    const g = geometry();
    view = fit(pinchView(start.view, start.mid, start.dist, g.mid, g.dist));
  }

  function onPointerEnd(e: PointerEvent) {
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size > 0) {
      // 指が残っているなら、残りの指で続ける（タップにはしない）
      const [, rest] = [...pointers.entries()][0];
      restart(rest);
      return;
    }
    start = null;
    if (e.type === 'pointerup' && !moved) handleTap(local(e));
  }

  /** 1 本指のタップ。ダブルタップで拡大・等倍に戻し、等倍の背景タップなら閉じる */
  function handleTap(p: Point) {
    const tap = { t: Date.now(), x: p.x, y: p.y };
    if (isDoubleTap(lastTap, tap)) {
      clearTimeout(closeTimer);
      lastTap = null;
      view = fit(view.scale > MIN_ZOOM ? { ...IDENTITY_VIEW } : zoomAt(view, DOUBLE_TAP_ZOOM, p));
      return;
    }
    lastTap = tap;
    // 拡大中は、タップで閉じない
    if (view.scale > MIN_ZOOM) return;
    closeTimer = setTimeout(() => {
      ui.lightbox = null;
    }, CLOSE_DELAY);
  }

  // Ctrl+ホイール（トラックパッドのピンチ）で拡大縮小する。WebView 自体のズームは止める
  $effect(() => {
    const el = stageEl;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const p = local(e);
      view = fit(zoomAt(view, zoomByWheel(view.scale, e.deltaY), p));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  // 開くたびに等倍・中央から始める
  $effect(() => {
    void ui.lightbox;
    view = { ...IDENTITY_VIEW };
    lastTap = null;
    start = null;
    pointers.clear();
    clearTimeout(closeTimer);
  });
</script>

<svelte:window
  onkeydown={(e) => e.key === 'Escape' && ui.lightbox && (ui.lightbox = null)}
  onresize={() => (view = fit(view))}
/>

{#if ui.lightbox}
  {@const lb = ui.lightbox}
  <div class="lightbox" role="dialog" aria-modal="true" aria-label={lb.alt}>
    <div
      class="lightbox-stage"
      class:zoomed={view.scale > MIN_ZOOM}
      role="presentation"
      bind:this={stageEl}
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerEnd}
      onpointercancel={onPointerEnd}
    >
      <img bind:this={imgEl} class="lightbox-image" src={lb.src} alt={lb.alt} style:transform />
    </div>
    <div class="lightbox-toolbar">
      <span class="lightbox-file-name">{lb.alt}</span>
      <a class="icon-btn lightbox-download" href={lb.downloadUrl} download={lb.alt} target="_blank" rel="noopener" aria-label="ダウンロード"
        ><Download size={20} /></a
      >
      <IconButton class="lightbox-close" label="閉じる" onclick={() => (ui.lightbox = null)}><X size={22} /></IconButton>
    </div>
  </div>
{/if}

<style>
  .lightbox {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: grid;
    place-items: center;
    background: oklch(0.1 0.01 248 / 0.92);
    animation: fade 0.15s;
  }
  /* 全画面の操作面。ブラウザ自身のパン・ズームは効かせず、指の動きはすべてこちらで受ける */
  .lightbox-stage {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    overflow: hidden;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    cursor: zoom-out;
  }
  .lightbox-stage.zoomed {
    cursor: grab;
  }
  .lightbox-image {
    position: relative;
    max-width: calc(100vw - 32px);
    max-height: calc(100dvh - 96px);
    object-fit: contain;
    border-radius: 4px;
    box-shadow: 0 10px 40px oklch(0 0 0 / 0.5);
    pointer-events: none;
  }
  .lightbox-toolbar {
    position: absolute;
    top: calc(env(safe-area-inset-top) + 8px);
    left: 12px;
    right: 8px;
    display: flex;
    align-items: center;
    gap: 4px;
    color: oklch(0.93 0.015 248);
  }
  .lightbox-toolbar > :global(.icon-btn) {
    color: inherit;
  }
  .lightbox-toolbar > :global(.icon-btn:hover) {
    background: oklch(1 0 0 / 0.1);
  }
  .lightbox-file-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 14px;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
</style>
