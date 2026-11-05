<script lang="ts">
  import X from '@lucide/svelte/icons/x';
  import Download from '@lucide/svelte/icons/download';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import type { Snippet } from 'svelte';
  import IconButton from './ui/IconButton.svelte';
  import { VIEWERS } from './viewers';
  import type { TapMode } from '../lib/viewers';
  import { adjacentItem, type LightboxItem } from '../lib/lightbox';
  import { swipeOutcome, SLIDE_GAP, SWIPE_EDGE_RESISTANCE } from '../lib/lightboxSwipe';

  // 拡大表示の本体（全画面）。写真の拡大表示（Lightbox.svelte）と、ライブの共有映像（ScreenShareViewer.svelte）が同じ部品を使う。
  // 表示するもの・前後の一覧・閉じる・切り替えは、呼び出し側から受ける（ui.lightbox は Lightbox.svelte だけが読む）。
  // 拡大表示（全画面）。ファイルの種類ごとの見え方・拡大はビューアー（components/viewers/）が受け持ち、
  // ここは前後の切り替え（←→ キー・ボタン・1 本指の左右のスワイプ）・ファイル名・ダウンロード・閉じるを受け持つ。
  // 前後の切り替えは、ビューアーが等倍のときだけ（拡大中の 1 本指・←→ は、ビューアーの移動・スクロールに使う）。
  // スワイプの間は、指に合わせて前後のファイルが横から出てくる（前後のビューアーも隣に置いておく）

  let {
    item,
    gallery = null,
    onchange,
    onclose,
    open: openProp,
    layer = 100,
    navigable = true,
    closeOnEscape = true,
    chrome = true,
    tapMode = 'close',
    onmediatap,
    download = true,
    class: className = '',
    title,
    actions,
    empty,
    element = $bindable<HTMLElement | null>(null),
    tabIndex,
  }: {
    /** いま見ているもの。無ければ（open でなければ）出さない */
    item: LightboxItem | null;
    gallery?: (() => LightboxItem[]) | null;
    onchange?: (item: LightboxItem) => void;
    onclose?: () => void;
    /** 出すか（既定は item があるとき。item が無くても出すのは、映像を待つ間など） */
    open?: boolean;
    layer?: number;
    /** ←→ キー・スワイプで前後へ移るか */
    navigable?: boolean;
    closeOnEscape?: boolean;
    /** 上のバーと前後のボタンを出すか（小窓のときは映像だけ）。隠しても、この部品は自分では隠さない（呼び出し側が決める） */
    chrome?: boolean;
    /** 背景・画像のタップの扱い。'media' は画像の上のタップを onmediatap に渡し、閉じない（既定 'close'） */
    tapMode?: TapMode;
    /** tapMode が 'media' のとき、画像の上を 1 回タップした（ダブルタップの拡大には使わない） */
    onmediatap?: () => void;
    download?: boolean;
    class?: string;
    /** ファイル名の代わりに出すもの（共有の見る人の切り替えなど） */
    title?: Snippet;
    /** ダウンロード・閉じるの前に並べるボタン */
    actions?: Snippet;
    /** item が無いときの中身 */
    empty?: Snippet;
    element?: HTMLElement | null;
    tabIndex?: number;
  } = $props();

  const open = $derived(openProp ?? item !== null);

  /** 切り替えのアニメーションの長さ（ms） */
  const SLIDE_MS = 220;

  /** いまのビューアーが等倍から拡大しているか */
  let zoomed = $state(false);
  /** 並びのずれ（px。スワイプ中は指に合わせる） */
  let dx = $state(0);
  /** アニメーション中か（transition を付ける） */
  let sliding = $state(false);
  let slideTimer: ReturnType<typeof setTimeout> | undefined;
  let rootEl = $state<HTMLElement | null>(null);
  $effect(() => {
    element = rootEl;
  });

  /** 前後（一覧が無い・端のときは null）。一覧は移るたびに取り直す */
  const items = $derived(item && navigable && gallery ? gallery() : []);
  const prev = $derived(item ? adjacentItem(items, item.src, -1) : null);
  const next = $derived(item ? adjacentItem(items, item.src, 1) : null);
  /** 並べるもの（前・いま・次）。前後のビューアーは、スワイプで見えるよう隣に置く */
  const slides = $derived.by(() => {
    const lb = item;
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
      onchange?.(target);
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
    if (!open || !navigable || !item || zoomed || e.isComposing) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    step(e.key === 'ArrowLeft' ? -1 : 1);
  }

  function close(): void {
    onclose?.();
  }

  // 閉じたら、途中の切り替えを捨てる
  $effect(() => {
    if (open) return;
    clearTimeout(slideTimer);
    sliding = false;
    dx = 0;
    zoomed = false;
    swipe = null;
  });
</script>

<svelte:window onkeydown={(e) => closeOnEscape && e.key === 'Escape' && open && close()} onkeydowncapture={onKeyCapture} />

{#if open}
  {@const lb = item}
  <div class={`lightbox ${className}`} style:z-index={layer} role="dialog" aria-modal="true" aria-label={lb?.alt ?? ''} tabindex={tabIndex} bind:this={rootEl}>
    <div class="lightbox-track" class:lightbox-sliding={sliding} style:transform="translateX({dx}px)" style:--lightbox-slide-ms="{SLIDE_MS}ms">
      {#each slides as s (s.item.key ?? s.item.src)}
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
            {tapMode}
            onimagetap={onmediatap}
          />
        </div>
      {/each}
    </div>
    <!-- 前後（端では出さない）。PC 向けの押すボタン。タッチはスワイプで移る -->
    {#if !item && empty}{@render empty()}{/if}
    {#if chrome && prev}
      <button type="button" class="icon-btn lightbox-nav lightbox-prev" aria-label="前のファイル" onclick={() => step(-1)}><ChevronLeft size={28} /></button>
    {/if}
    {#if chrome && next}
      <button type="button" class="icon-btn lightbox-nav lightbox-next" aria-label="次のファイル" onclick={() => step(1)}><ChevronRight size={28} /></button>
    {/if}
    {#if chrome}
      <div class="lightbox-toolbar">
        {#if title}{@render title()}{:else}<span class="lightbox-file-name">{lb?.alt ?? ''}</span>{/if}
        {#if actions}{@render actions()}{/if}
        {#if download && lb}
          <a class="icon-btn lightbox-download" href={lb.downloadUrl} download={lb.alt} target="_blank" rel="noopener" aria-label="ダウンロード"
            ><Download size={20} /></a
          >
        {/if}
        <IconButton class="lightbox-close" label="閉じる" onclick={close}><X size={22} /></IconButton>
      </div>
    {/if}
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
    left: max(12px, env(safe-area-inset-left));
    right: max(8px, env(safe-area-inset-right));
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
    left: max(8px, env(safe-area-inset-left));
  }
  .lightbox-next {
    right: max(8px, env(safe-area-inset-right));
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
