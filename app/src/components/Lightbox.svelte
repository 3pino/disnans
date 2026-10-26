<script lang="ts">
  import X from '@lucide/svelte/icons/x';
  import Download from '@lucide/svelte/icons/download';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import IconButton from './ui/IconButton.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { adjacentItem } from '../lib/lightbox';
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
  /** 横のスワイプとみなす距離（px）。等倍のときだけ、1 本指のタッチで使う */
  const SWIPE_MIN = 56;

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
  /** スワイプの始まり（1 本指のタッチで、等倍のときだけ）。2 本指になったら取り消す */
  let swipeFrom: Point | null = null;
  /** このジェスチャーで 2 本指になったか（ピンチ）。ピンチの後は、スワイプにしない */
  let pinched = false;

  /** 前後の画像（一覧が無い・端のときは null）。一覧は移るたびに取り直す */
  const items = $derived(ui.lightbox && ui.lightboxGallery ? ui.lightboxGallery() : []);
  const prev = $derived(ui.lightbox ? adjacentItem(items, ui.lightbox.src, -1) : null);
  const next = $derived(ui.lightbox ? adjacentItem(items, ui.lightbox.src, 1) : null);

  /** 前（-1）か次（+1）の画像へ移る。端では動かさない。切り替えの表示（等倍・中央）は下の effect が戻す */
  function step(delta: -1 | 1): void {
    const lb = ui.lightbox;
    if (!lb || !ui.lightboxGallery) return;
    const target = adjacentItem(ui.lightboxGallery(), lb.src, delta);
    if (target) ui.lightbox = target;
  }

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
    if (pointers.size === 0) {
      moved = false;
      pinched = false;
      // スワイプは 1 本指のタッチで、拡大していないときだけ（拡大中はパンを優先する）
      swipeFrom = e.pointerType === 'touch' && view.scale <= MIN_ZOOM ? p : null;
    }
    pointers.set(e.pointerId, p);
    if (pointers.size > 1) {
      moved = true;
      pinched = true;
      swipeFrom = null;
    }
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
    const from = swipeFrom;
    swipeFrom = null;
    if (e.type === 'pointerup' && from && !pinched) {
      // 横が縦より大きく、一定以上動いたら、前か次へ（左へ動かすと次）
      const to = local(e);
      const dx = to.x - from.x;
      if (Math.abs(dx) >= SWIPE_MIN && Math.abs(dx) > Math.abs(to.y - from.y)) {
        step(dx < 0 ? 1 : -1);
        return;
      }
    }
    if (e.type === 'pointerup' && !moved) handleTap(local(e));
  }

  /** ← → キーで前後へ。拡大表示が開いている間は、入力欄などより先に受ける（その分は伝えない） */
  function onKeyCapture(e: KeyboardEvent): void {
    if (!ui.lightbox || e.isComposing) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    step(e.key === 'ArrowLeft' ? -1 : 1);
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
  onkeydowncapture={onKeyCapture}
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
    <!-- 前後の画像（端では出さない）。PC 向けの押すボタン。タッチはスワイプで移る -->
    {#if prev}
      <button type="button" class="icon-btn lightbox-nav lightbox-prev" aria-label="前の画像" onclick={() => step(-1)}><ChevronLeft size={28} /></button>
    {/if}
    {#if next}
      <button type="button" class="icon-btn lightbox-nav lightbox-next" aria-label="次の画像" onclick={() => step(1)}><ChevronRight size={28} /></button>
    {/if}
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
    background: var(--scrim-strong);
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
    border-radius: var(--radius-xs);
    box-shadow: var(--shadow-media);
    pointer-events: none;
  }
  .lightbox-toolbar {
    position: absolute;
    top: calc(env(safe-area-inset-top) + 8px);
    left: 12px;
    right: 8px;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--on-scrim);
  }
  .lightbox-toolbar > :global(.icon-btn) {
    color: inherit;
  }
  .lightbox-toolbar > :global(.icon-btn:hover) {
    background: var(--on-scrim-soft);
  }
  .lightbox-nav {
    position: absolute;
    top: 50%;
    z-index: 1;
    transform: translateY(-50%);
    color: var(--on-scrim);
  }
  .lightbox-prev {
    left: 8px;
  }
  .lightbox-next {
    right: 8px;
  }
  .lightbox-nav:hover {
    background: var(--on-scrim-soft);
  }
  .lightbox-file-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-base);
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
</style>
