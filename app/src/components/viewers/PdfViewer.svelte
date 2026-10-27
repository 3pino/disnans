<script lang="ts">
  import ZoomIn from '@lucide/svelte/icons/zoom-in';
  import ZoomOut from '@lucide/svelte/icons/zoom-out';
  import { tick, untrack } from 'svelte';
  import IconButton from '../ui/IconButton.svelte';
  import { PDF_DOUBLE_TAP_ZOOM, PDF_MAX_ZOOM, PDF_MIN_ZOOM, anchoredScroll, clampZoom, stepZoom } from '../../lib/pdfZoom';
  import { loadPdfjs } from '../../lib/pdfjs';
  import { attachmentActionText } from '../../lib/fileLink';
  import { zoomGesture, type GestureFrame } from '../../lib/zoomGesture';
  import type { ViewerProps } from '../../lib/viewers';
  import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';

  // PDF のビューアー（拡大表示の中）。ページを縦に並べてスクロールで見る。
  // ページは画面に近づいてから描き、拡大・縮小（ピンチ・ダブルタップ・ボタン・Ctrl+ホイール）では見えているページだけ描き直す。
  // 等倍のときは横にスクロールしない（1 本指の左右の動きは、Lightbox が前後の切り替えに使う）
  let { src, active, onzoom }: ViewerProps = $props();

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
      // 前後の隣のものも開くので、全体は先読みしない（見るページの分だけ Range で取る）
      const task = pdfjs.getDocument({ url, isEvalSupported: false, disableAutoFetch: true });
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

  // ---- ピンチ・ダブルタップ・Ctrl+ホイール（lib/zoomGesture）。1 本指のスクロールはブラウザーに任せる ----
  // ピンチ・ホイールの間は見た目だけ拡大し（描き直さない）、終わったらその倍率で描く

  /** 見た目だけの拡大の始まり（倍率と中心）。null はしていない */
  let preview: { zoom: number; mid: { x: number; y: number } } | null = null;
  /** 見た目の倍率（始まりの倍率に対して） */
  let previewScale = 1;
  let wheelTimer: ReturnType<typeof setTimeout> | undefined;
  /** ホイールが止まってから描き直すまで（ms） */
  const WHEEL_SETTLE_MS = 160;

  /** 見た目の拡大（ページの並びを、中心の点で拡大する） */
  function showPreview(scale: number): void {
    if (!pagesEl || !scroller || !preview) return;
    previewScale = clampZoom(preview.zoom * scale) / preview.zoom;
    const ox = scroller.scrollLeft + preview.mid.x - pagesEl.offsetLeft;
    const oy = scroller.scrollTop + preview.mid.y - pagesEl.offsetTop;
    pagesEl.style.transformOrigin = `${ox}px ${oy}px`;
    pagesEl.style.transform = previewScale === 1 ? '' : `scale(${previewScale})`;
  }

  /** 見た目の拡大を終え、その倍率で描き直す */
  function commitPreview(): void {
    clearTimeout(wheelTimer);
    if (!preview) return;
    const { zoom: from, mid } = preview;
    const scale = previewScale;
    if (pagesEl) pagesEl.style.transform = '';
    preview = null;
    previewScale = 1;
    setZoom(from * scale, mid);
  }

  const gesture = {
    start: (f: GestureFrame) => {
      commitPreview();
      if (active && f.count >= 2) preview = { zoom, mid: f.mid };
    },
    move: (first: GestureFrame, now: GestureFrame) => {
      if (preview && now.count >= 2) showPreview(now.dist / Math.max(1, first.dist));
    },
    end: () => commitPreview(),
    tap: (p: { x: number; y: number }, double: boolean) => {
      // ダブルタップ: 等倍なら拡大、拡大中なら等倍に戻す（タップした所を中心に）
      if (active && double) setZoom(zoom > PDF_MIN_ZOOM + 0.01 ? PDF_MIN_ZOOM : PDF_DOUBLE_TAP_ZOOM, p);
    },
    wheel: (factor: number, p: { x: number; y: number }) => {
      if (!active) return;
      // トラックパッドのピンチは小さい量が続けて届く。止まるまでは見た目だけ拡大する
      if (!preview) preview = { zoom, mid: p };
      showPreview(previewScale * factor);
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(commitPreview, WHEEL_SETTLE_MS);
    },
  };

  const zoomed = $derived(zoom > PDF_MIN_ZOOM + 0.001);
  $effect(() => {
    const z = zoomed;
    untrack(() => onzoom?.(z));
  });

  // 隣（前後）に回ったら、等倍・先頭に戻す
  $effect(() => {
    if (active) return;
    untrack(() => {
      commitPreview();
      zoom = PDF_MIN_ZOOM;
      if (scroller) scroller.scrollTop = 0;
    });
  });
</script>

<div class="pdf-viewer scroll" class:pdf-viewer-zoomed={zoomed} bind:this={scroller} bind:clientWidth={scrollerWidth} use:zoomGesture={gesture}>
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
{#if doc && active}
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
    /* 1 本指のスクロールはブラウザー、2 本指（ピンチ）はこちらで受ける。等倍のときの左右は、前後の切り替えのスワイプ */
    touch-action: pan-y;
  }
  .pdf-viewer-zoomed {
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
