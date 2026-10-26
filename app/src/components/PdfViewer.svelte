<script lang="ts">
  import ZoomIn from '@lucide/svelte/icons/zoom-in';
  import ZoomOut from '@lucide/svelte/icons/zoom-out';
  import IconButton from './ui/IconButton.svelte';
  import { loadPdfjs } from '../lib/pdfjs';
  import { attachmentActionText } from '../lib/fileLink';
  import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';

  // PDF のプレビュー（全画面の Lightbox の中）。ページを縦に並べてスクロールで見る。
  // ページは画面に近づいてから描き、拡大・縮小（ボタン・Ctrl+ホイール）では見えているページだけ描き直す
  let { src }: { src: string } = $props();

  /** 拡大の段階（1 = 幅に合わせる） */
  const ZOOMS = [1, 1.5, 2, 3];
  /** 等倍のときのページの幅の上限（px） */
  const MAX_PAGE_WIDTH = 900;
  /** 描く画像の幅の上限（px。大きく拡大しても、端末のメモリを使いすぎない） */
  const MAX_CANVAS_WIDTH = 4096;

  let doc = $state.raw<PDFDocumentProxy | null>(null);
  let count = $state(0);
  /** 1 ページ目の高さ / 幅（描く前のページの枠の大きさに使う） */
  let ratio = $state(Math.SQRT2);
  let error = $state<string | null>(null);
  let zoom = $state(0);
  let scroller: HTMLDivElement | undefined = $state();
  let scrollerWidth = $state(0);
  const pageWidth = $derived(Math.round(Math.max(120, Math.min(scrollerWidth - 32, MAX_PAGE_WIDTH)) * ZOOMS[zoom]));

  $effect(() => {
    const url = src;
    let alive = true;
    let destroy: (() => Promise<void>) | null = null;
    doc = null;
    count = 0;
    error = null;
    zoom = 0;
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

  function setZoom(next: number): void {
    const z = Math.max(0, Math.min(ZOOMS.length - 1, next));
    if (z === zoom || !scroller) return;
    // 見ている場所（縦の割合）を保つ
    const at = scroller.scrollTop / Math.max(1, scroller.scrollHeight);
    zoom = z;
    requestAnimationFrame(() => {
      if (scroller) scroller.scrollTop = at * scroller.scrollHeight;
    });
  }

  // Ctrl+ホイール（トラックパッドのピンチ）で拡大・縮小する。WebView 自体のズームは止める
  $effect(() => {
    const el = scroller;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom(zoom + (e.deltaY < 0 ? 1 : -1));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });
</script>

<div class="pdf-viewer scroll" bind:this={scroller} bind:clientWidth={scrollerWidth}>
  {#if error}
    <p class="pdf-viewer-status" role="alert">PDF を開けませんでした: {error}</p>
  {:else if !doc}
    <p class="pdf-viewer-status">読み込み中…</p>
  {:else}
    <div class="pdf-viewer-pages">
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
    <IconButton label="縮小" disabled={zoom === 0} onclick={() => setZoom(zoom - 1)}><ZoomOut size={20} /></IconButton>
    <IconButton label="拡大" disabled={zoom === ZOOMS.length - 1} onclick={() => setZoom(zoom + 1)}><ZoomIn size={20} /></IconButton>
  </div>
{/if}

<style>
  /* 上の操作の帯（ファイル名・ダウンロード・閉じる）の下から、画面いっぱいにスクロールする */
  .pdf-viewer {
    position: absolute;
    inset: calc(env(safe-area-inset-top) + 52px) 0 0;
    overflow: auto;
    overscroll-behavior: contain;
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
