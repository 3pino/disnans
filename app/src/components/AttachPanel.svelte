<script lang="ts">
  import Camera from '@lucide/svelte/icons/camera';
  import ImageIcon from '@lucide/svelte/icons/image';
  import Paperclip from '@lucide/svelte/icons/paperclip';
  import X from '@lucide/svelte/icons/x';
  import Button from './ui/Button.svelte';
  import IconButton from './ui/IconButton.svelte';
  import { listRecentImages, type RecentImage } from '../lib/recentImages';

  // 入力欄の上に出す「ファイルを追加」パネル。ボタンは入力欄（Composer）の隠しの入力を開く。見た目は仮
  let {
    oncamera,
    onimage,
    onfile,
    onrecent,
    onclose,
  }: {
    oncamera: () => void;
    onimage: () => void;
    onfile: () => void;
    onrecent: (image: RecentImage) => void;
    onclose: () => void;
  } = $props();

  let recent = $state<RecentImage[]>([]);
  $effect(() => {
    let alive = true;
    listRecentImages().then(
      (list) => {
        if (alive) recent = list;
      },
      () => {
        if (alive) recent = [];
      },
    );
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
    {#each recent as image (image.id)}
      <button type="button" class="attach-panel-recent-item" aria-label="{image.name} を添付" onclick={() => onrecent(image)}>
        <img class="attach-panel-recent-img" src={image.thumbUrl} alt="" loading="lazy" decoding="async" />
      </button>
    {:else}
      <p class="muted attach-panel-empty">最近の画像はありません</p>
    {/each}
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
  .attach-panel-empty {
    grid-column: 1 / -1;
    margin: 0;
    font-size: var(--fs-sm);
  }
</style>
