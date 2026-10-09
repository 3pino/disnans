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

<div class="scrim" role="presentation" onclick={onclose}></div>
<div class="sheet" role="dialog" aria-label="メッセージの操作">
  {#if reactions.length > 0}
    <div class="reacts">
      {#each reactions as e (e)}
        <button
          type="button"
          onclick={() => {
            onreact?.(e);
            onclose();
          }}>{e}</button
        >
      {/each}
      {#if onmorereactions}
        <button
          type="button"
          class="more"
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
      class="item"
      class:danger={it.danger}
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
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: oklch(0.1 0.03 248 / 0.45);
    animation: fade 0.15s;
  }
  .sheet {
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
  .reacts {
    display: flex;
    justify-content: space-between;
    gap: 4px;
    padding-bottom: 10px;
    margin-bottom: 6px;
    border-bottom: 1px solid var(--border);
  }
  .reacts button {
    flex: 1;
    height: 48px;
    border: none;
    border-radius: 12px;
    background: var(--surface-2);
    font-size: 24px;
  }
  .reacts .more {
    display: grid;
    place-items: center;
    color: var(--text-muted);
  }
  .item {
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
  .item:active {
    background: var(--surface-2);
  }
  .item.danger {
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
