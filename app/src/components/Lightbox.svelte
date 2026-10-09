<script lang="ts">
  import X from '@lucide/svelte/icons/x';
  import Download from '@lucide/svelte/icons/download';
  import { ui } from '../lib/stores/ui.svelte';
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && ui.lightbox && (ui.lightbox = null)} />

{#if ui.lightbox}
  {@const lb = ui.lightbox}
  <div class="lightbox" role="dialog" aria-modal="true" aria-label={lb.alt}>
    <button type="button" class="bg" aria-label="閉じる" onclick={() => (ui.lightbox = null)}></button>
    <img src={lb.src} alt={lb.alt} />
    <div class="tools">
      <span class="name">{lb.alt}</span>
      <a class="icon-btn" href={lb.downloadUrl} download={lb.alt} target="_blank" rel="noopener" aria-label="ダウンロード"
        ><Download size={20} /></a
      >
      <button type="button" class="icon-btn" aria-label="閉じる" onclick={() => (ui.lightbox = null)}><X size={22} /></button>
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
    background: oklch(0.12 0.03 248 / 0.92);
    animation: fade 0.15s;
  }
  .bg {
    position: absolute;
    inset: 0;
    border: none;
    background: transparent;
    cursor: zoom-out;
  }
  img {
    position: relative;
    max-width: calc(100vw - 32px);
    max-height: calc(100dvh - 96px);
    object-fit: contain;
    border-radius: 4px;
    box-shadow: 0 10px 40px oklch(0 0 0 / 0.5);
    pointer-events: none;
  }
  .tools {
    position: absolute;
    top: max(8px, env(safe-area-inset-top));
    left: 12px;
    right: 8px;
    display: flex;
    align-items: center;
    gap: 4px;
    color: oklch(0.88 0.06 248);
  }
  .tools .icon-btn {
    color: inherit;
  }
  .tools .icon-btn:hover {
    background: oklch(1 0 0 / 0.1);
  }
  .name {
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
