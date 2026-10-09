<script lang="ts">
  import X from '@lucide/svelte/icons/x';
  import Download from '@lucide/svelte/icons/download';
  import { ui } from '../lib/stores/ui.svelte';
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && ui.lightbox && (ui.lightbox = null)} />

{#if ui.lightbox}
  {@const lb = ui.lightbox}
  <div class="lightbox" role="dialog" aria-modal="true" aria-label={lb.alt}>
    <button type="button" class="lightbox-backdrop" aria-label="閉じる" onclick={() => (ui.lightbox = null)}></button>
    <img class="lightbox-image" src={lb.src} alt={lb.alt} />
    <div class="lightbox-toolbar">
      <span class="lightbox-file-name">{lb.alt}</span>
      <a class="icon-btn lightbox-download" href={lb.downloadUrl} download={lb.alt} target="_blank" rel="noopener" aria-label="ダウンロード"
        ><Download size={20} /></a
      >
      <button type="button" class="icon-btn lightbox-close" aria-label="閉じる" onclick={() => (ui.lightbox = null)}><X size={22} /></button>
    </div>
  </div>
{/if}

<style>
  .lightbox {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: grid;
    place-items: center;
    background: oklch(0.1 0.01 248 / 0.92);
    animation: fade 0.15s;
  }
  .lightbox-backdrop {
    position: absolute;
    inset: 0;
    border: none;
    background: transparent;
    cursor: zoom-out;
  }
  .lightbox-image {
    position: relative;
    max-width: calc(100vw - 32px);
    max-height: calc(100dvh - 96px);
    object-fit: contain;
    border-radius: 4px;
    box-shadow: 0 10px 40px oklch(0 0 0 / 0.5);
    pointer-events: none;
  }
  .lightbox-toolbar {
    position: absolute;
    top: calc(env(safe-area-inset-top) + 8px);
    left: 12px;
    right: 8px;
    display: flex;
    align-items: center;
    gap: 4px;
    color: oklch(0.93 0.015 248);
  }
  .lightbox-toolbar .icon-btn {
    color: inherit;
  }
  .lightbox-toolbar .icon-btn:hover {
    background: oklch(1 0 0 / 0.1);
  }
  .lightbox-file-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 14px;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
</style>
