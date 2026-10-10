<script lang="ts">
  import SmilePlus from '@lucide/svelte/icons/smile-plus';
  import MenuItem from './ui/MenuItem.svelte';
  import type { IconRef } from '../lib/icons.svelte';

  type Item = { id?: string; label: string; icon: IconRef; danger?: boolean; run: () => void };

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
  <div class="action-sheet-items" role="menu">
    {#each items as it (it.id ?? it.label)}
      <MenuItem
        class="action-sheet-item"
        icon={it.icon}
        iconSize={20}
        danger={it.danger}
        onclick={() => {
          onclose();
          it.run();
        }}
      >
        {it.label}
      </MenuItem>
    {/each}
  </div>
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
  /* 項目の見た目は .menu-item（app.css）。指で押しやすいよう大きくする */
  .action-sheet-items > :global(.action-sheet-item) {
    gap: 14px;
    height: 50px;
    padding: 0 12px;
    font-size: 16px;
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
