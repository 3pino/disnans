<script lang="ts">
  import type { Inline } from '../lib/markdown';
  import { client } from '../lib/stores/client.svelte';
  import InlineNodes from './InlineNodes.svelte';

  let { nodes }: { nodes: Inline[] } = $props();
</script>

{#each nodes as n, i (i)}
  {#if n.type === 'text'}{n.text}{:else if n.type === 'bold'}<strong><InlineNodes nodes={n.children} /></strong
    >{:else if n.type === 'italic'}<em><InlineNodes nodes={n.children} /></em>{:else if n.type === 'link'}<a
      href={n.href}
      target="_blank"
      rel="noopener noreferrer">{n.text}</a
    >{:else if n.type === 'mention'}<span
      class="mention"
      class:me={client.me?.id === n.userId}
      title={client.user(n.userId)?.login_name}>@{client.nameOf(n.userId)}</span
    >{/if}
{/each}

<style>
  .mention {
    padding: 0 3px;
    border-radius: 4px;
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
  }
  .mention.me {
    background: var(--mention-soft);
    color: var(--mention);
  }
  a {
    word-break: break-all;
  }
</style>
