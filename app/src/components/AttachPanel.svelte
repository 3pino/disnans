<script lang="ts">
  import Camera from '@lucide/svelte/icons/camera';
  import ImageIcon from '@lucide/svelte/icons/image';
  import Paperclip from '@lucide/svelte/icons/paperclip';
  import X from '@lucide/svelte/icons/x';
  import Button from './ui/Button.svelte';
  import RecentThumb from './RecentThumb.svelte';
  import IconButton from './ui/IconButton.svelte';
  import {
    listRecentImages,
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
  let permission = $state<RecentPermission>('granted');
  const notice = $derived(permissionNotice(permission));
  $effect(() => {
    let alive = true;
    void (async () => {
      // 初回のパネルを開いたときだけ、写真の許可を求める（ダイアログが出うる）。失敗しても一覧は読む
      if (!hasAskedRecentImages()) {
        markAskedRecentImages();
        await requestRecentImagesPermission().catch((e: unknown) => console.warn('写真の許可を求められませんでした', e));
      }
      try {
        const res = await listRecentImages();
        if (!alive) return;
        recent = res.images;
        permission = res.permission;
      } catch (e) {
        console.warn('最近の画像を読めませんでした', e);
        if (alive) recent = [];
      }
    })();
    return () => {
      alive = false;
    };
  });
</script>

<div class="attach-panel" role="group" aria-label="ファイルを追加">
  <div class="attach-panel-head">
    <div class="attach-panel-buttons">
      <Button icon={Camera} onclick={oncamera}>カメラ</Button>
      <Button icon={ImageIcon} onclick={onimage}>画像</Button>
      <Button icon={Paperclip} onclick={onfile}>ファイル</Button>
    </div>
    <IconButton label="パネルを閉じる" onclick={onclose}><X size={16} /></IconButton>
  </div>
  <div class="attach-panel-recent">
    {#if clip}
      <button
        type="button"
        class="attach-panel-recent-item attach-panel-clipboard"
        aria-label="クリップボードの画像を添付"
        onclick={() => clip && onclipboard(clip.file)}
      >
        <img class="attach-panel-recent-img" src={clip.url} alt="" decoding="async" />
      </button>
    {/if}
    {#each recent as image (image.id)}
      <button type="button" class="attach-panel-recent-item" aria-label="{image.name} を添付" onclick={() => onrecent(image)}>
        <RecentThumb {image} />
      </button>
    {/each}
    {#if !clip && recent.length === 0 && !notice}
      <p class="muted attach-panel-empty">最近の画像はありません</p>
    {/if}
  </div>
  {#if notice}
    <p class="muted attach-panel-notice" role="note">{notice}</p>
  {/if}
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
  .attach-panel-recent {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-2);
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
  .attach-panel-empty,
  .attach-panel-notice {
    margin: 0;
    font-size: var(--fs-sm);
  }
  .attach-panel-empty {
    grid-column: 1 / -1;
  }
</style>
