<script lang="ts">
  import FileIcon from '@lucide/svelte/icons/file';
  import FileX from '@lucide/svelte/icons/file-x';
  import Download from '@lucide/svelte/icons/download';
  import type { Attachment } from '../lib/protocol/Attachment';
  import { fileUrl } from '../lib/config';
  import { interceptDownload } from '../lib/download';
  import { formatSize } from '../lib/format';
  import { bodyAttachmentNames, isImage } from '../lib/fileLink';
  import { ui } from '../lib/stores/ui.svelte';
  import { chatGallery } from '../lib/chatGallery';

  // 本文に埋め込まれた添付は、本文の中（FileLink）で出す。ここは本文に無い添付（送信の途中の仮表示など）だけを出す
  let {
    attachments,
    body,
    local = {},
  }: { attachments: Attachment[]; body: string; local?: Record<string, string> } = $props();

  const linked = $derived(bodyAttachmentNames(body));
  const unlinked = $derived(attachments.filter((a) => !linked.has(a.file_name.toLowerCase())));
  // 削除された添付は名前だけ出し、開けない。残りが今ある添付
  const live = $derived(unlinked.filter((a) => !a.deleted));
  const gone = $derived(unlinked.filter((a) => a.deleted));
  // 画像かどうかは mime と拡張子で決める（isImage）。mime が汎用のままの画像も、画像として出す
  const images = $derived(live.filter((a) => isImage(a.file_name, a.mime)));
  const files = $derived(live.filter((a) => !isImage(a.file_name, a.mime)));

  function thumbSrc(a: Attachment): string {
    return local[a.id] ?? fileUrl(a.id, a.has_thumb);
  }

  /**
   * 画像の大きさは CSS が決める（テーマの変数 --chat-image-row-height / --chat-image-single-max / --chat-image-max-height。既定は app.css）。
   * ここは縦横の比（--att-r）と、1 枚のときの元の高さ（--att-h。寸法が分かるときだけ）を渡す。寸法が分からなければ正方形。
   */
  function dims(a: Attachment): { ratio: number; height: number | null } {
    const known = !!a.width && !!a.height;
    return { ratio: known ? a.width! / a.height! : 1, height: known ? a.height! : null };
  }
</script>

{#if images.length > 0}
  <!-- 横一列。はみ出した分は横にスクロールする（横スワイプ・Shift+ホイール・トラックパッド）。枚数の上限は無い -->
  <div class="attachment-images">
    {#each images as a (a.id)}
      {@const d = dims(a)}
      <div class="attachment-item">
        <button
          type="button"
          class="attachment-image"
          class:attachment-image-single={images.length === 1}
          style:--att-r={d.ratio}
          style:--att-h={d.height === null ? undefined : `${d.height}px`}
          style:aspect-ratio={d.ratio}
          onclick={() => ui.openLightbox({ src: local[a.id] ?? fileUrl(a.id), alt: a.file_name, downloadUrl: fileUrl(a.id) }, chatGallery)}
          aria-label="{a.file_name} を開く"
        >
          <img class="attachment-image-thumb" src={thumbSrc(a)} alt={a.file_name} loading="lazy" decoding="async" />
        </button>
      </div>
    {/each}
  </div>
{/if}

{#if files.length > 0}
  <div class="attachment-files">
    {#each files as a (a.id)}
      <div class="attachment-item">
        <a class="attachment-file" href={fileUrl(a.id)} download={a.file_name} target="_blank" rel="noopener" onclick={(ev) => interceptDownload(ev, { url: fileUrl(a.id), name: a.file_name })}>
          <FileIcon size={18} />
          <span class="attachment-file-name">{a.file_name}</span>
          <span class="attachment-file-size">{formatSize(a.size)}</span>
          <Download size={16} />
        </a>
      </div>
    {/each}
  </div>
{/if}

{#if gone.length > 0}
  <div class="attachment-files">
    {#each gone as a (a.id)}
      <div class="attachment-file attachment-file-deleted" role="note">
        <FileX size={18} />
        <span class="attachment-file-name">{a.file_name}</span>
        <span class="attachment-file-size">削除されたファイル</span>
      </div>
    {/each}
  </div>
{/if}

<style>
  .attachment-item {
    position: relative;
    display: inline-flex;
    max-width: 100%;
  }
  .attachment-file-deleted {
    color: var(--text-muted);
    font-style: italic;
  }
  .attachment-images {
    display: flex;
    flex-wrap: nowrap;
    align-items: flex-start;
    gap: var(--space-3);
    width: 100%;
    min-width: 0;
    margin-top: var(--space-3);
    overflow-x: auto;
    overflow-y: hidden;
    overscroll-behavior-x: contain;
    -webkit-overflow-scrolling: touch;
  }
  .attachment-images > .attachment-item {
    flex: none;
  }
  /* 全デバイス共通。複数は行の高さ、1 枚は長辺の上限（元より大きくはしない）に収め、どちらも高さは --chat-image-max-height まで。
     縦横の比は保つ（切り取らない）。数字はテーマの変数（app.css に既定） */
  .attachment-image {
    --att-fit: min(var(--chat-image-row-height), var(--chat-image-max-height));
    height: var(--att-fit);
    width: calc(var(--att-fit) * var(--att-r));
  }
  .attachment-image-single {
    --att-fit: min(
      var(--att-h, var(--chat-image-single-max)),
      var(--chat-image-single-max),
      calc(var(--chat-image-single-max) / var(--att-r)),
      var(--chat-image-max-height)
    );
  }
  .attachment-image {
    display: block;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: var(--surface-2);
    min-width: 40px;
    cursor: zoom-in;
  }
  .attachment-image .attachment-image-thumb {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .attachment-files {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2);
    margin-top: var(--space-3);
  }
  .attachment-file {
    display: inline-flex;
    align-items: center;
    gap: var(--space-4);
    max-width: 100%;
    padding: var(--space-4) var(--space-6);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    text-decoration: none;
    font-size: var(--fs-base);
  }
  .attachment-file:hover {
    border-color: var(--border-hover);
  }
  .attachment-file-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .attachment-file-size {
    color: var(--text-muted);
    font-size: var(--fs-sm);
    flex: none;
  }
</style>
