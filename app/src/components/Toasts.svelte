<script lang="ts">
  import X from '@lucide/svelte/icons/x';
  import { ui } from '../lib/stores/ui.svelte';
</script>

<div class="toasts" aria-live="polite">
  {#each ui.toasts as t (t.id)}
    <div class="toast" class:error={t.kind === 'error'}>
      <span class="text">{t.text}</span>
      {#if t.action}
        {@const action = t.action}
        <button
          type="button"
          class="act"
          onclick={() => {
            action.run();
            ui.dismiss(t.id);
          }}>{action.label}</button
        >
      {/if}
      <button type="button" class="icon-btn" aria-label="閉じる" onclick={() => ui.dismiss(t.id)}><X size={14} /></button>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    top: calc(env(safe-area-inset-top) + 12px);
    left: 50%;
    transform: translateX(-50%);
    z-index: 90;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: min(440px, calc(100vw - 24px));
    pointer-events: none;
  }
  .toast {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 6px 8px 14px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    font-size: 14px;
    pointer-events: auto;
    animation: drop 0.18s ease-out;
  }
  .toast.error {
    border-left-color: var(--danger);
  }
  .text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
  }
  .act {
    border: none;
    background: none;
    color: var(--accent);
    font-weight: 600;
  }
  .icon-btn {
    width: 26px;
    height: 26px;
  }
  @keyframes drop {
    from {
      opacity: 0;
      transform: translateY(-8px);
    }
  }
</style>
