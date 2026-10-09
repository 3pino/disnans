<script lang="ts">
  import SmilePlus from '@lucide/svelte/icons/smile-plus';
  import type { Message } from '../lib/protocol/Message';
  import { client } from '../lib/stores/client.svelte';

  let { message, onaddclick }: { message: Message; onaddclick: (rect: DOMRect) => void } = $props();
  const meId = $derived(client.me?.id);
</script>

{#if message.reactions.length > 0}
  <div class="reactions">
    {#each message.reactions as r (r.emoji)}
      {#if r.user_ids.length > 0}
        <button
          type="button"
          class="pill"
          class:mine={meId !== undefined && r.user_ids.includes(meId)}
          title={r.user_ids.map((id) => client.nameOf(id)).join('、')}
          onclick={() => client.toggleReaction(message, r.emoji)}
        >
          <span class="emoji">{r.emoji}</span>
          <span class="count">{r.user_ids.length}</span>
        </button>
      {/if}
    {/each}
    <button
      type="button"
      class="pill add"
      aria-label="リアクションを追加"
      onclick={(e) => onaddclick(e.currentTarget.getBoundingClientRect())}
    >
      <SmilePlus size={15} />
    </button>
  </div>
{/if}

<style>
  .reactions {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 4px;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 26px;
    padding: 0 8px;
    border-radius: 13px;
    border: 1px solid var(--border);
    background: var(--surface);
    font-size: 13px;
  }
  .pill:hover {
    border-color: var(--text-muted);
  }
  .pill.mine {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
  }
  .emoji {
    font-size: 15px;
    line-height: 1;
  }
  .count {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .add {
    color: var(--text-muted);
    opacity: 0;
    transition: opacity 0.12s;
  }
  :global(.msg:hover) .add,
  .add:focus-visible {
    opacity: 1;
  }
  @media (hover: none) {
    .add {
      opacity: 1;
    }
  }
</style>
