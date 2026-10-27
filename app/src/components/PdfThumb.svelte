<script lang="ts">
  import FileText from '@lucide/svelte/icons/file-text';
  import { pdfThumb } from '../lib/pdfThumb';

  // 共有フォルダのアイコン表示の、PDF の 1 ページ目のサムネイル。画面に入ってから作る（作るまで・作れなければファイルの絵）
  let { url, key }: { url: string; key: string } = $props();

  let el: HTMLSpanElement | undefined = $state();
  let src = $state<string | null>(null);

  $effect(() => {
    const target = el;
    const u = url;
    const k = key;
    src = null;
    // IntersectionObserver の無い環境（テストなど）では作らない
    if (!target || typeof IntersectionObserver === 'undefined') return;
    let alive = true;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      // 枠（最大 240px 程度）を、画面の細かさ（最大 2 倍）で描く
      const px = Math.round(240 * Math.min(2, window.devicePixelRatio || 1));
      void pdfThumb(u, k, px).then((made) => {
        if (alive) src = made;
      });
    }, { rootMargin: '200px' });
    io.observe(target);
    return () => {
      alive = false;
      io.disconnect();
    };
  });
</script>

<span bind:this={el} class="pdf-thumb">
  {#if src}
    <img {src} alt="" decoding="async" />
  {:else}
    <FileText size={64} />
  {/if}
</span>

<style>
  /* 枠いっぱいの箱（画面に入ったかを見るため）。画像は欠けないよう、全体を枠に収める */
  .pdf-thumb {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
  }
  .pdf-thumb img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
</style>
