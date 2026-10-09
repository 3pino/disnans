<script lang="ts">
  import type { Snippet } from 'svelte';
  import Paperclip from '@lucide/svelte/icons/paperclip';
  import MessageList from './MessageList.svelte';
  import Composer from './Composer.svelte';
  import { client } from '../lib/stores/client.svelte';

  let {
    threadId,
    placeholder,
    header,
    empty,
  }: { threadId: string | null; placeholder: string; header?: Snippet; empty?: Snippet } = $props();

  const timeline = $derived(client.timeline(threadId));
  let composer: Composer | undefined = $state();
  let dragDepth = $state(0);

  $effect(() => {
    if (client.ready && !timeline.loaded && !timeline.loading) void timeline.load();
  });

  function hasFiles(e: DragEvent) {
    return [...(e.dataTransfer?.types ?? [])].includes('Files');
  }
</script>

<section
  class="chat"
  aria-label={threadId ? 'スレッド' : 'チャット'}
  ondragenter={(e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
  }}
  ondragover={(e) => {
    if (hasFiles(e)) e.preventDefault();
  }}
  ondragleave={(e) => {
    if (hasFiles(e)) dragDepth = Math.max(0, dragDepth - 1);
  }}
  ondrop={(e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) composer?.addFiles(files);
  }}
>
  <MessageList {timeline} inThread={threadId !== null} {header} {empty} />
  <Composer bind:this={composer} {threadId} {placeholder} />

  {#if dragDepth > 0}
    <div class="drop">
      <div class="drop-inner">
        <Paperclip size={28} />
        <span>ドロップして添付</span>
      </div>
    </div>
  {/if}
</section>

<style>
  .chat {
    position: relative;
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }
  .drop {
    position: absolute;
    inset: 8px;
    z-index: 40;
    display: grid;
    place-items: center;
    border: 2px dashed var(--accent);
    border-radius: var(--radius);
    background: color-mix(in oklch, var(--bg) 85%, transparent);
    pointer-events: none;
  }
  .drop-inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    color: var(--accent);
    font-weight: 600;
  }
</style>
