<script lang="ts">
  import Camera from '@lucide/svelte/icons/camera';
  import Clipboard from '@lucide/svelte/icons/clipboard';
  import ImageIcon from '@lucide/svelte/icons/image';
  import Paperclip from '@lucide/svelte/icons/paperclip';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import X from '@lucide/svelte/icons/x';
  import Button from './ui/Button.svelte';
  import RecentThumb from './RecentThumb.svelte';
  import IconButton from './ui/IconButton.svelte';
  import {
    listRecentImages,
    RECENT_IMAGE_MAX,
    recentGridFit,
    permissionNotice,
    requestRecentImagesPermission,
    type RecentImage,
    type RecentPermission,
  } from '../lib/recentImages';
  import { hasAskedRecentImages, markAskedRecentImages } from '../lib/recentImagesNative';
  import { readClipboardImage } from '../lib/clipboardImage';

  // 入力欄の上に出す「ファイルを追加」パネル。ボタンは入力欄（Composer）の隠しの入力を開く。見た目は仮
  let {
    oncamera,
    onimage,
    onfile,
    onrecent,
    onclipboard,
    onclose,
  }: {
    oncamera: () => void;
    onimage: () => void;
    onfile: () => void;
    onrecent: (image: RecentImage) => void;
    /** クリップボードの画像（先頭に出す）を添付する */
    onclipboard: (file: File) => void;
    onclose: () => void;
  } = $props();

  /** クリップボードの画像（パネルを開いたときに読む。閉じると消す） */
  let clip = $state<{ file: File; url: string } | null>(null);
  $effect(() => {
    let alive = true;
    let url: string | null = null;
    void readClipboardImage().then(
      (file) => {
        if (!alive || !file) return;
        url = URL.createObjectURL(file);
        clip = { file, url };
      },
      () => {},
    );
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
      clip = null;
    };
  });

  let recent = $state<RecentImage[]>([]);
  // 枠の大きさ: 幅（測る）と、高さの上限（画面の半分）に入るだけ並べる。上限は RECENT_IMAGE_MAX
  let gridEl = $state<HTMLDivElement | undefined>();
  let gridWidth = $state(0);
  let viewH = $state(0);
  let gap = $state(8);
  const maxH = $derived(Math.floor(viewH * 0.5));
  const fit = $derived(recentGridFit({ width: gridWidth, maxHeight: maxH, gap }));
  /** 枠に入る件数（クリップボードの 1 件を含む）。幅が分からないうちは上限まで */
  const slots = $derived(gridWidth > 0 ? fit.capacity : RECENT_IMAGE_MAX);
  /** 枠に出す最近の画像。クリップボードの画像があれば、その 1 件を先頭に足して、残りを埋める（合計は同じ） */
  const shown = $derived(recent.slice(0, slots - (clip ? 1 : 0)));
  $effect(() => {
    if (gridEl) gap = parseFloat(getComputedStyle(gridEl).columnGap) || 8;
  });
  let permission = $state<RecentPermission>('granted');
  /** 読み込み中（初期は読み込み中。読めて 0 件のときだけ空の文言を出す） */
  let loading = $state(true);
  /** 一覧を読めなかった（空とは区別して出す） */
  let failed = $state(false);
  /** 再試行の回数（増えると読み直す） */
  let attempt = $state(0);
  const notice = $derived(permissionNotice(permission));
  $effect(() => {
    void attempt;
    let alive = true;
    loading = true;
    failed = false;
    void (async () => {
      // 初回のパネルを開いたときだけ、写真の許可を求める（ダイアログが出うる）。失敗しても一覧は読む
      if (!hasAskedRecentImages()) {
        markAskedRecentImages();
        await requestRecentImagesPermission().catch((e: unknown) => console.warn('写真の許可を求められませんでした', e));
      }
      try {
        const res = await listRecentImages(RECENT_IMAGE_MAX);
        if (!alive) return;
        recent = res.images;
        permission = res.permission;
      } catch (e) {
        console.warn('最近の画像を読めませんでした', e);
        if (alive) {
          recent = [];
          failed = true;
        }
      } finally {
        if (alive) loading = false;
      }
    })();
    return () => {
      alive = false;
    };
  });
</script>

<svelte:window bind:innerHeight={viewH} />

<div class="attach-panel" role="group" aria-label="ファイルを追加">
  <!-- 最近の画像の一覧だけがスクロールし、ボタンの行はパネルの下に残す -->
  <div
    class="attach-panel-recent"
    bind:this={gridEl}
    bind:clientWidth={gridWidth}
    style:grid-template-columns="repeat({fit.cols}, {fit.tile}px)"
    style:max-height="{maxH}px"
  >
    {#if clip}
      <button
        type="button"
        class="attach-panel-recent-item attach-panel-clipboard"
        aria-label="クリップボードの画像を添付"
        onclick={() => clip && onclipboard(clip.file)}
      >
        <img class="attach-panel-recent-img" src={clip.url} alt="" decoding="async" />
        <span class="attach-panel-clipboard-mark" aria-hidden="true"><Clipboard size={12} /></span>
      </button>
    {/if}
    {#each shown as image (image.id)}
      <button type="button" class="attach-panel-recent-item" aria-label="{image.name} を添付" onclick={() => onrecent(image)}>
        <RecentThumb {image} />
      </button>
    {/each}
    {#if loading}
      <p class="muted attach-panel-empty">読み込み中</p>
    {:else if failed}
      <div class="attach-panel-empty attach-panel-error" role="alert">
        <p>最近の画像を読み込めませんでした</p>
        <Button icon={RefreshCw} onclick={() => attempt++}>再試行</Button>
      </div>
    {:else if !clip && recent.length === 0 && !notice}
      <p class="muted attach-panel-empty">最近の画像はありません</p>
    {/if}
  </div>
  {#if notice}
    <p class="muted attach-panel-notice" role="note">{notice}</p>
  {/if}
  <div class="attach-panel-head">
    <div class="attach-panel-buttons">
      <Button icon={Camera} onclick={oncamera}>カメラ</Button>
      <Button icon={ImageIcon} onclick={onimage}>画像</Button>
      <Button icon={Paperclip} onclick={onfile}>ファイル</Button>
    </div>
    <IconButton label="パネルを閉じる" onclick={onclose}><X size={16} /></IconButton>
  </div>
</div>

<style>
  .attach-panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    margin-bottom: var(--space-3);
    padding: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
  }
  .attach-panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .attach-panel-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
  }
  /* 列数・タイルの幅・高さの上限は、スクリプトで決めて入れる（recentGridFit）。はみ出すときだけ中で送る */
  .attach-panel-recent {
    display: grid;
    justify-content: start;
    gap: var(--space-2);
    overflow-y: auto;
  }
  .attach-panel-recent-item {
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    overflow: hidden;
    background: var(--surface-2);
    aspect-ratio: 1;
  }
  .attach-panel-recent-img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  /* クリップボード由来の印（右下の小さい丸。画像の上に重ねる） */
  .attach-panel-clipboard {
    position: relative;
  }
  .attach-panel-clipboard-mark {
    position: absolute;
    right: var(--space-1);
    bottom: var(--space-1);
    display: inline-grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--surface);
    color: var(--text-muted);
    box-shadow: 0 0 0 1px var(--border);
  }
  .attach-panel-empty,
  .attach-panel-notice {
    margin: 0;
    font-size: var(--fs-sm);
  }
  .attach-panel-empty {
    grid-column: 1 / -1;
  }
  .attach-panel-error {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-3);
    font-size: var(--fs-sm);
    color: var(--danger);
  }
  .attach-panel-error p {
    margin: 0;
  }
</style>
