<script lang="ts">
  import FileIcon from '@lucide/svelte/icons/file';
  import Download from '@lucide/svelte/icons/download';
  import type { Attachment } from '../lib/protocol/Attachment';
  import { fileUrl } from '../lib/config';
  import { formatSize } from '../lib/format';
  import { ui } from '../lib/stores/ui.svelte';

  let { attachments, local = {} }: { attachments: Attachment[]; local?: Record<string, string> } = $props();

  const images = $derived(attachments.filter((a) => a.mime.startsWith('image/')));
  const files = $derived(attachments.filter((a) => !a.mime.startsWith('image/')));

  function thumbSrc(a: Attachment): string {
    return local[a.id] ?? fileUrl(a.id, a.has_thumb);
  }

  // 表示サイズ: 長辺 320px 程度に収める
  function box(a: Attachment): { w: number; h: number } | null {
    if (!a.width || !a.height) return null;
    const max = images.length > 1 ? 200 : 320;
    const s = Math.min(1, max / Math.max(a.width, a.height));
    return { w: Math.round(a.width * s), h: Math.round(a.height * s) };
  }
</script>

{#if images.length > 0}
  <div class="attachment-images">
    {#each images as a (a.id)}
      {@const b = box(a)}
      <button
        type="button"
        class="attachment-image"
        style:width={b ? `${b.w}px` : undefined}
        style:aspect-ratio={b ? `${b.w} / ${b.h}` : undefined}
        onclick={() => (ui.lightbox = { src: local[a.id] ?? fileUrl(a.id), alt: a.file_name, downloadUrl: fileUrl(a.id) })}
        aria-label="{a.file_name} を開く"
      >
        <img class="attachment-image-thumb" src={thumbSrc(a)} alt={a.file_name} loading="lazy" decoding="async" />
      </button>
    {/each}
  </div>
{/if}

{#if files.length > 0}
  <div class="attachment-files">
    {#each files as a (a.id)}
      <a class="attachment-file" href={fileUrl(a.id)} download={a.file_name} target="_blank" rel="noopener">
        <FileIcon size={18} />
        <span class="attachment-file-name">{a.file_name}</span>
        <span class="attachment-file-size">{formatSize(a.size)}</span>
        <Download size={16} />
      </a>
    {/each}
  </div>
{/if}

<style>
  .attachment-images {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 6px;
  }
  .attachment-image {
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: var(--surface-2);
    max-width: 100%;
    min-width: 60px;
    min-height: 60px;
    cursor: zoom-in;
  }
  .attachment-image .attachment-image-thumb {
    display: block;
    width: 100%;
    height: 100%;
    max-height: 320px;
    object-fit: cover;
  }
  .attachment-files {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    margin-top: 6px;
  }
  .attachment-file {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    max-width: 100%;
    padding: 8px 12px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    text-decoration: none;
    font-size: 14px;
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
    font-size: 12px;
    flex: none;
  }
</style>
