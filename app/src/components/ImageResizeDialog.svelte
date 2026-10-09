<script lang="ts">
  import Modal from './ui/Modal.svelte';
  import { resizeOptions, type ImageInfo } from '../lib/imageResize';
  import { formatSize } from '../lib/format';

  // 画像の大きさを選ぶダイアログ。選ぶと閉じる（縮小は送信するときに行う）
  let {
    file,
    info,
    value,
    onpick,
    onclose,
  }: {
    file: File;
    info: ImageInfo;
    /** 今の選択（長辺。null は元のまま） */
    value: number | null;
    onpick: (maxEdge: number | null) => void;
    onclose: () => void;
  } = $props();

  const options = $derived(resizeOptions(info, { size: file.size, mime: file.type }));
</script>

<Modal title="画像の大きさ" {onclose} width={360}>
  <p class="image-resize-source muted">元の画像: {info.width} × {info.height} · {formatSize(file.size)}</p>
  <div class="image-resize-options" role="radiogroup" aria-label="画像の大きさ">
    {#each options as o (o.choice.id)}
      {@const selected = o.choice.maxEdge === value}
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        class="image-resize-option"
        class:image-resize-option-selected={selected}
        disabled={o.disabled}
        onclick={() => onpick(o.choice.maxEdge)}
      >
        <span class="image-resize-option-label">{o.choice.label}</span>
        <span class="image-resize-option-detail">
          {#if o.disabled}
            縮小しません
          {:else if o.choice.maxEdge === null}
            {o.width} × {o.height} · {formatSize(o.bytes)}
          {:else}
            {o.width} × {o.height} · 約 {formatSize(o.bytes)}
          {/if}
        </span>
      </button>
    {/each}
  </div>
  <p class="image-resize-note muted">
    サイズは目安です。送るときに縮小し、形式は JPEG（透過がある画像は PNG）になります。
  </p>
</Modal>

<style>
  .image-resize-source {
    margin: -6px 0 12px;
    font-size: 13px;
  }
  .image-resize-options {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .image-resize-option {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    padding: 9px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    text-align: left;
    transition:
      border-color 0.12s,
      background-color 0.12s;
  }
  .image-resize-option:hover:not(:disabled) {
    background: var(--surface-2);
  }
  .image-resize-option-selected {
    border-color: var(--accent);
  }
  .image-resize-option:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .image-resize-option-label {
    font-weight: 600;
  }
  .image-resize-option-detail {
    color: var(--text-muted);
    font-size: 13px;
    text-align: right;
  }
  .image-resize-note {
    margin: 12px 0 0;
    font-size: 12px;
    line-height: 1.6;
  }
</style>
