<script lang="ts">
  import type { Component } from 'svelte';
  import SmilePlus from '@lucide/svelte/icons/smile-plus';

  type Item = { label: string; icon: Component<{ size?: number }>; danger?: boolean; run: () => void };

  let {
    items,
    reactions = [],
    onreact,
    onmorereactions,
    onclose,
  }: {
    items: Item[];
    reactions?: string[];
    onreact?: (emoji: string) => void;
    onmorereactions?: () => void;
    onclose: () => void;
  } = $props();
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />

<div class="action-sheet-scrim" role="presentation" onclick={onclose}></div>
<div class="action-sheet" role="dialog" aria-label="メッセージの操作">
  {#if reactions.length > 0}
    <div class="action-sheet-reactions">
      {#each reactions as e (e)}
        <button
          type="button"
          class="action-sheet-reaction"
          onclick={() => {
            onreact?.(e);
            onclose();
          }}>{e}</button
        >
      {/each}
      {#if onmorereactions}
        <button
          type="button"
          class="action-sheet-reaction action-sheet-more-reactions"
          aria-label="ほかのリアクション"
          onclick={() => {
            onclose();
            onmorereactions();
          }}><SmilePlus size={22} /></button
        >
      {/if}
    </div>
  {/if}
  {#each items as it (it.label)}
    <button
      type="button"
      class="action-sheet-item"
      class:action-sheet-item-danger={it.danger}
      onclick={() => {
        onclose();
        it.run();
      }}
    >
      <it.icon size={20} />
      {it.label}
    </button>
  {/each}
</div>

<style>
  .action-sheet-scrim {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: oklch(0.08 0.01 248 / 0.45);
    animation: fade 0.15s;
  }
  .action-sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 61;
    padding: 12px 12px max(12px, env(safe-area-inset-bottom));
    background: var(--surface);
    border-top: 1px solid var(--border);
    border-radius: 16px 16px 0 0;
    box-shadow: var(--shadow);
    animation: up 0.18s ease-out;
  }
  .action-sheet-reactions {
    display: flex;
    justify-content: space-between;
    gap: 4px;
    padding-bottom: 10px;
    margin-bottom: 6px;
    border-bottom: 1px solid var(--border);
  }
  .action-sheet-reactions .action-sheet-reaction {
    flex: 1;
    height: 48px;
    border: none;
    border-radius: 12px;
    background: var(--surface-2);
    font-size: 24px;
  }
  .action-sheet-reactions .action-sheet-more-reactions {
    display: grid;
    place-items: center;
    color: var(--text-muted);
  }
  .action-sheet-item {
    display: flex;
    align-items: center;
    gap: 14px;
    width: 100%;
    height: 50px;
    padding: 0 12px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    font-size: 16px;
    text-align: left;
  }
  .action-sheet-item:active {
    background: var(--surface-2);
  }
  .action-sheet-item.action-sheet-item-danger {
    color: var(--danger);
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  @keyframes up {
    from {
      transform: translateY(100%);
    }
  }
</style>
