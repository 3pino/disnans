<script lang="ts">
  import X from '@lucide/svelte/icons/x';
  import Download from '@lucide/svelte/icons/download';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import IconButton from './ui/IconButton.svelte';
  import { VIEWERS } from './viewers';
  import { ui } from '../lib/stores/ui.svelte';
  import { adjacentItem, type LightboxItem } from '../lib/lightbox';
  import { swipeOutcome, SLIDE_GAP, SWIPE_EDGE_RESISTANCE } from '../lib/lightboxSwipe';

  // 拡大表示（全画面）。ファイルの種類ごとの見え方・拡大はビューアー（components/viewers/）が受け持ち、
  // ここは前後の切り替え（←→ キー・ボタン・1 本指の左右のスワイプ）・ファイル名・ダウンロード・閉じるを受け持つ。
  // 前後の切り替えは、ビューアーが等倍のときだけ（拡大中の 1 本指・←→ は、ビューアーの移動・スクロールに使う）。
  // スワイプの間は、指に合わせて前後のファイルが横から出てくる（前後のビューアーも隣に置いておく）

  /** 切り替えのアニメーションの長さ（ms） */
  const SLIDE_MS = 220;

  /** いまのビューアーが等倍から拡大しているか */
  let zoomed = $state(false);
  /** 並びのずれ（px。スワイプ中は指に合わせる） */
  let dx = $state(0);
  /** アニメーション中か（transition を付ける） */
  let sliding = $state(false);
  let slideTimer: ReturnType<typeof setTimeout> | undefined;
  let rootEl = $state<HTMLDivElement>();

  /** 前後（一覧が無い・端のときは null）。一覧は移るたびに取り直す */
  const items = $derived(ui.lightbox && ui.lightboxGallery ? ui.lightboxGallery() : []);
  const prev = $derived(ui.lightbox ? adjacentItem(items, ui.lightbox.src, -1) : null);
  const next = $derived(ui.lightbox ? adjacentItem(items, ui.lightbox.src, 1) : null);
  /** 並べるもの（前・いま・次）。前後のビューアーは、スワイプで見えるよう隣に置く */
  const slides = $derived.by(() => {
    const lb = ui.lightbox;
    if (!lb) return [];
    const out: { item: LightboxItem; offset: -1 | 0 | 1 }[] = [];
    if (prev) out.push({ item: prev, offset: -1 });
    out.push({ item: lb, offset: 0 });
    if (next) out.push({ item: next, offset: 1 });
    return out;
  });

  function width(): number {
    return rootEl?.clientWidth || window.innerWidth;
  }

  /** 前（-1）か次（+1）へ、横に流してから移る。端・動いている最中は動かさない */
  function step(delta: -1 | 1): void {
    const target = delta < 0 ? prev : next;
    if (!target || sliding) {
      if (!sliding) settle();
      return;
    }
    sliding = true;
    dx = -delta * (width() + SLIDE_GAP);
    clearTimeout(slideTimer);
    slideTimer = setTimeout(() => {
      // 隣にあったビューアーが真ん中に来る（keyed なので部品は作り直さない）。ずれは同時に 0 に戻す
      sliding = false;
      dx = 0;
      zoomed = false;
      ui.lightbox = target;
    }, SLIDE_MS);
  }

  /** 元の位置に戻す（スワイプが足りなかった） */
  function settle(): void {
    if (dx === 0) return;
    sliding = true;
    dx = 0;
    clearTimeout(slideTimer);
    slideTimer = setTimeout(() => (sliding = false), SLIDE_MS);
  }

  // ---- 1 本指の左右のスワイプ（タッチ。等倍のときだけ） ----

  /** スワイプの始まり。axis は向きが決まったら x（スワイプ）か y（縦のスクロールに任せる） */
  let swipe: { x: number; y: number; t: number; axis: 'x' | 'y' | null } | null = null;

  function onTouchStart(e: TouchEvent): void {
    if (e.touches.length !== 1 || zoomed || sliding) {
      // 2 本指になったら（ピンチ）、スワイプはやめて元に戻す
      if (swipe?.axis === 'x') settle();
      swipe = null;
      return;
    }
    const t = e.touches[0];
    swipe = { x: t.clientX, y: t.clientY, t: Date.now(), axis: null };
  }

  function onTouchMove(e: TouchEvent): void {
    if (!swipe || e.touches.length !== 1) return;
    const t = e.touches[0];
    const mx = t.clientX - swipe.x;
    const my = t.clientY - swipe.y;
    if (swipe.axis === null) {
      if (Math.abs(mx) > 10 && Math.abs(mx) > Math.abs(my)) swipe.axis = 'x';
      else if (Math.abs(my) > 10) swipe.axis = 'y';
    }
    if (swipe.axis !== 'x') return;
    if (e.cancelable) e.preventDefault();
    // 端（その向きに続きが無い）では、少しだけ動いて戻る
    const blocked = (mx > 0 && !prev) || (mx < 0 && !next);
    dx = blocked ? mx * SWIPE_EDGE_RESISTANCE : mx;
  }

  function onTouchEnd(e: TouchEvent): void {
    if (!swipe || e.touches.length > 0) return;
    const s = swipe;
    swipe = null;
    if (s.axis !== 'x') return;
    const t = e.changedTouches[0];
    const mx = (t?.clientX ?? s.x) - s.x;
    const delta = swipeOutcome(mx, Date.now() - s.t, width());
    if (delta) step(delta);
    else settle();
  }

  $effect(() => {
    const el = rootEl;
    if (!el) return;
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', onTouchEnd);
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  });

  /** ← → キーで前後へ（等倍のときだけ）。拡大表示が開いている間は、入力欄などより先に受ける（その分は伝えない） */
  function onKeyCapture(e: KeyboardEvent): void {
    if (!ui.lightbox || zoomed || e.isComposing) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    step(e.key === 'ArrowLeft' ? -1 : 1);
  }

  function close(): void {
    ui.lightbox = null;
  }

  // 閉じたら、途中の切り替えを捨てる
  $effect(() => {
    if (ui.lightbox) return;
    clearTimeout(slideTimer);
    sliding = false;
    dx = 0;
    zoomed = false;
    swipe = null;
  });
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && ui.lightbox && close()} onkeydowncapture={onKeyCapture} />

{#if ui.lightbox}
  {@const lb = ui.lightbox}
  <div class="lightbox" role="dialog" aria-modal="true" aria-label={lb.alt} bind:this={rootEl}>
    <div class="lightbox-track" class:lightbox-sliding={sliding} style:transform="translateX({dx}px)" style:--lightbox-slide-ms="{SLIDE_MS}ms">
      {#each slides as s (s.item.src)}
        {@const Viewer = VIEWERS[s.item.kind ?? 'image']}
        <div
          class="lightbox-slide"
          class:lightbox-slide-current={s.offset === 0}
          style:transform="translateX(calc({s.offset * 100}% + {s.offset * SLIDE_GAP}px))"
          aria-hidden={s.offset !== 0}
        >
          <Viewer
            src={s.item.src}
            alt={s.item.alt}
            active={s.offset === 0}
            onzoom={(z) => {
              if (s.offset === 0) zoomed = z;
            }}
            ontap={close}
          />
        </div>
      {/each}
    </div>
    <!-- 前後（端では出さない）。PC 向けの押すボタン。タッチはスワイプで移る -->
    {#if prev}
      <button type="button" class="icon-btn lightbox-nav lightbox-prev" aria-label="前のファイル" onclick={() => step(-1)}><ChevronLeft size={28} /></button>
    {/if}
    {#if next}
      <button type="button" class="icon-btn lightbox-nav lightbox-next" aria-label="次のファイル" onclick={() => step(1)}><ChevronRight size={28} /></button>
    {/if}
    <div class="lightbox-toolbar">
      <span class="lightbox-file-name">{lb.alt}</span>
      <a class="icon-btn lightbox-download" href={lb.downloadUrl} download={lb.alt} target="_blank" rel="noopener" aria-label="ダウンロード"
        ><Download size={20} /></a
      >
      <IconButton class="lightbox-close" label="閉じる" onclick={close}><X size={22} /></IconButton>
    </div>
  </div>
{/if}

<style>
  .lightbox {
    position: fixed;
    inset: 0;
    z-index: 100;
    overflow: hidden;
    background: var(--scrim-strong);
    animation: fade 0.15s;
  }
  /* 前・いま・次を横に並べる帯。スワイプの間は指に合わせてずらす */
  .lightbox-track {
    position: absolute;
    inset: 0;
  }
  .lightbox-sliding {
    transition: transform var(--lightbox-slide-ms) ease-out;
  }
  .lightbox-slide {
    position: absolute;
    inset: 0;
  }
  /* 隣（前後）は見えるだけで、押せない */
  .lightbox-slide:not(.lightbox-slide-current) {
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
