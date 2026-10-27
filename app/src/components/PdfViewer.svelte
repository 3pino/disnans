<script lang="ts">
  import ZoomIn from '@lucide/svelte/icons/zoom-in';
  import ZoomOut from '@lucide/svelte/icons/zoom-out';
  import { tick } from 'svelte';
  import IconButton from './ui/IconButton.svelte';
  import { PDF_DOUBLE_TAP_ZOOM, PDF_MAX_ZOOM, PDF_MIN_ZOOM, anchoredScroll, clampZoom, stepZoom } from '../lib/pdfZoom';
  import { isDoubleTap, type TapRecord } from '../lib/zoom';
  import { loadPdfjs } from '../lib/pdfjs';
  import { attachmentActionText } from '../lib/fileLink';
  import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';

  // PDF のプレビュー（全画面の Lightbox の中）。ページを縦に並べてスクロールで見る。
  // ページは画面に近づいてから描き、拡大・縮小（ピンチ・ダブルタップ・ボタン・Ctrl+ホイール）では見えているページだけ描き直す。
  // ピンチの間は見た目だけ拡大し（描き直さない）、指を離したらその倍率で描く
  let { src }: { src: string } = $props();

  /** 等倍のときのページの幅の上限（px） */
  const MAX_PAGE_WIDTH = 900;
  /** 描く画像の幅の上限（px。大きく拡大しても、端末のメモリを使いすぎない） */
  const MAX_CANVAS_WIDTH = 4096;

  let doc = $state.raw<PDFDocumentProxy | null>(null);
  let count = $state(0);
  /** 1 ページ目の高さ / 幅（描く前のページの枠の大きさに使う） */
  let ratio = $state(Math.SQRT2);
  let error = $state<string | null>(null);
  /** 倍率（1 = 幅に合わせる） */
  let zoom = $state(PDF_MIN_ZOOM);
  let scroller: HTMLDivElement | undefined = $state();
  let pagesEl: HTMLDivElement | undefined = $state();
  let scrollerWidth = $state(0);
  const pageWidth = $derived(Math.round(Math.max(120, Math.min(scrollerWidth - 32, MAX_PAGE_WIDTH)) * zoom));

  $effect(() => {
    const url = src;
    let alive = true;
    let destroy: (() => Promise<void>) | null = null;
    doc = null;
    count = 0;
    error = null;
    zoom = PDF_MIN_ZOOM;
    void (async () => {
      const pdfjs = await loadPdfjs();
      if (!alive) return;
      // PDF の中のスクリプトは評価しない
      const task = pdfjs.getDocument({ url, isEvalSupported: false });
      destroy = () => task.destroy();
      const d = await task.promise;
      const first = (await d.getPage(1)).getViewport({ scale: 1 });
      if (!alive) return;
      ratio = first.height / first.width;
      count = d.numPages;
      doc = d;
    })().catch((e) => {
      if (alive) error = attachmentActionText(e);
    });
    return () => {
      alive = false;
      void destroy?.();
    };
  });

  /** 1 ページを canvas に描く。画面に近づいたら描き、幅が変わったら（拡大・縮小）描き直す */
  function page(canvas: HTMLCanvasElement, arg: { doc: PDFDocumentProxy; n: number; width: number }) {
    let cur = arg;
    let visible = false;
    /** 描いた（描いている）幅。同じ幅なら描き直さない */
    let drawn = 0;
    let task: RenderTask | null = null;

    async function draw(): Promise<void> {
      if (!visible || drawn === cur.width) return;
      const { doc: d, n, width } = cur;
      drawn = width;
      task?.cancel();
      task = null;
      const p = await d.getPage(n);
      if (cur.width !== width || cur.doc !== d) return;
      const base = p.getViewport({ scale: 1 });
      const px = Math.min(width * Math.min(2, window.devicePixelRatio || 1), MAX_CANVAS_WIDTH);
      const viewport = p.getViewport({ scale: px / base.width });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      task = p.render({ canvasContext: ctx, viewport });
      try {
        await task.promise;
      } catch {
        // 描き直しで取り消した
      }
    }

    // IntersectionObserver の無い環境では、すぐ描く
    const io =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(
            (entries) => {
              visible = entries.some((e) => e.isIntersecting);
              void draw();
            },
            { root: scroller, rootMargin: '600px 0px' },
          );
    if (io) io.observe(canvas);
    else {
      visible = true;
      void draw();
    }
    return {
      update(next: { doc: PDFDocumentProxy; n: number; width: number }) {
        cur = next;
        void draw();
      },
      destroy() {
        io?.disconnect();
        task?.cancel();
      },
    };
  }

  /**
   * 倍率を変える。anchor（スクロールの枠の左上からの位置。省略は真ん中）の下にあった場所を、同じ所に残す
   */
  function setZoom(next: number, anchor?: { x: number; y: number }): void {
    const z = clampZoom(next);
    const el = scroller;
    if (!el || Math.abs(z - zoom) < 0.001) return;
    const a = anchor ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 };
    const to = anchoredScroll({ left: el.scrollLeft, top: el.scrollTop }, a, z / zoom);
    zoom = z;
    // ページの幅が変わってから、位置を合わせる
    void tick().then(() => {
      el.scrollLeft = to.left;
      el.scrollTop = to.top;
    });
  }

  /** スクロールの枠の左上からの位置 */
  function local(p: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = scroller!.getBoundingClientRect();
    return { x: p.clientX - r.left, y: p.clientY - r.top };
  }

  // ---- ピンチ・ダブルタップ（タッチ）。1 本指のスクロールはブラウザーに任せる ----

  /** ピンチの始まり（指の間隔・倍率・中点）。null はピンチしていない */
  let pinch: { dist: number; zoom: number; mid: { x: number; y: number } } | null = null;
  /** ピンチ中の見た目の倍率（始まりの倍率に対して） */
  let pinchScale = 1;
  let tapFrom: { x: number; y: number } | null = null;
  let lastTap: TapRecord | null = null;

  function spread(t: TouchList): { dist: number; mid: { x: number; y: number } } {
    const a = local(t[0]);
    const b = local(t[1]);
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }

  /** ピンチ中の見た目（ページの並びを、中点を中心に拡大する） */
  function showPinch(scale: number): void {
    if (!pagesEl || !scroller || !pinch) return;
    const ox = scroller.scrollLeft + pinch.mid.x - pagesEl.offsetLeft;
    const oy = scroller.scrollTop + pinch.mid.y - pagesEl.offsetTop;
    pagesEl.style.transformOrigin = `${ox}px ${oy}px`;
    pagesEl.style.transform = scale === 1 ? '' : `scale(${scale})`;
  }

  function onTouchStart(e: TouchEvent): void {
    if (e.touches.length >= 2) {
      const g = spread(e.touches);
      pinch = { dist: Math.max(1, g.dist), zoom, mid: g.mid };
      pinchScale = 1;
      tapFrom = null;
      return;
    }
    tapFrom = e.touches.length === 1 ? local(e.touches[0]) : null;
  }

  function onTouchMove(e: TouchEvent): void {
    if (tapFrom && e.touches.length === 1) {
      const p = local(e.touches[0]);
      if (Math.hypot(p.x - tapFrom.x, p.y - tapFrom.y) > 8) tapFrom = null;
    }
    if (!pinch || e.touches.length < 2) return;
    // 2 本指の間はスクロールさせず、拡大だけする
    e.preventDefault();
    const g = spread(e.touches);
    pinchScale = clampZoom((pinch.zoom * g.dist) / pinch.dist) / pinch.zoom;
    showPinch(pinchScale);
  }

  function onTouchEnd(e: TouchEvent): void {
    if (pinch && e.touches.length < 2) {
      const { zoom: from, mid } = pinch;
      showPinch(1);
      pinch = null;
      lastTap = null;
      setZoom(from * pinchScale, mid);
      return;
    }
    if (e.touches.length > 0 || !tapFrom) return;
    const tap = { t: Date.now(), x: tapFrom.x, y: tapFrom.y };
    tapFrom = null;
    if (isDoubleTap(lastTap, tap)) {
      // ダブルタップ: 等倍なら拡大、拡大中なら等倍に戻す（タップした所を中心に）
      lastTap = null;
      e.preventDefault();
      setZoom(zoom > PDF_MIN_ZOOM + 0.01 ? PDF_MIN_ZOOM : PDF_DOUBLE_TAP_ZOOM, tap);
      return;
    }
    lastTap = tap;
  }

  // 2 本指の動きを止めるため、touchmove は passive にしない。Ctrl+ホイール（トラックパッドのピンチ）でも拡大・縮小する
  $effect(() => {
    const el = scroller;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), local(e));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: false });
    el.addEventListener('touchcancel', onTouchEnd, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  });
</script>

<div class="pdf-viewer scroll" bind:this={scroller} bind:clientWidth={scrollerWidth}>
  {#if error}
    <p class="pdf-viewer-status" role="alert">PDF を開けませんでした: {error}</p>
  {:else if !doc}
    <p class="pdf-viewer-status">読み込み中…</p>
  {:else}
    <div class="pdf-viewer-pages" bind:this={pagesEl}>
      {#each { length: count } as _, i (i)}
        <canvas
          class="pdf-viewer-page"
          aria-label="{i + 1} ページ目"
          style:width="{pageWidth}px"
          style:aspect-ratio="1 / {ratio}"
          use:page={{ doc, n: i + 1, width: pageWidth }}
        ></canvas>
      {/each}
    </div>
  {/if}
</div>
{#if doc}
  <div class="pdf-viewer-zoom">
    <span class="pdf-viewer-count">{count} ページ</span>
    <IconButton label="縮小" disabled={zoom <= PDF_MIN_ZOOM} onclick={() => setZoom(stepZoom(zoom, -1))}><ZoomOut size={20} /></IconButton>
    <IconButton label="拡大" disabled={zoom >= PDF_MAX_ZOOM} onclick={() => setZoom(stepZoom(zoom, 1))}><ZoomIn size={20} /></IconButton>
  </div>
{/if}

<style>
  /* 上の操作の帯（ファイル名・ダウンロード・閉じる）の下から、画面いっぱいにスクロールする */
  .pdf-viewer {
    position: absolute;
    inset: calc(env(safe-area-inset-top) + 52px) 0 0;
    overflow: auto;
    overscroll-behavior: contain;
    /* 1 本指のスクロールはブラウザー、2 本指（ピンチ）はこちらで受ける */
    touch-action: pan-x pan-y;
  }
  .pdf-viewer-pages {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-6);
    width: max-content;
    min-width: 100%;
    padding: var(--space-4) var(--space-7) calc(env(safe-area-inset-bottom) + 72px);
    box-sizing: border-box;
  }
  .pdf-viewer-page {
    display: block;
    background: #fff;
    border-radius: var(--radius-xs);
    box-shadow: var(--shadow-media);
  }
  .pdf-viewer-status {
    margin: var(--space-8) var(--space-7);
    text-align: center;
    color: var(--on-scrim);
    overflow-wrap: anywhere;
  }
  .pdf-viewer-zoom {
    position: absolute;
    right: var(--space-7);
    bottom: calc(env(safe-area-inset-bottom) + var(--space-7));
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2) var(--space-1) var(--space-4);
    border-radius: var(--radius-sm);
    background: var(--scrim-strong);
    color: var(--on-scrim);
  }
  .pdf-viewer-zoom > :global(.icon-btn) {
    color: inherit;
  }
  .pdf-viewer-count {
    font-size: var(--fs-sm);
  }
</style>
