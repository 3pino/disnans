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
    active = false,
  }: {
    threadId: string | null;
    placeholder: string;
    header?: Snippet;
    empty?: Snippet;
    /** 画面に見えている（見えていて一番下までスクロールしていれば既読にする） */
    active?: boolean;
  } = $props();

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
  class="chat-view"
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
  <MessageList {timeline} inThread={threadId !== null} {header} {empty} {active} />
  <Composer bind:this={composer} {threadId} {placeholder} />

  {#if dragDepth > 0}
    <div class="chat-view-drop-overlay">
      <div class="chat-view-drop-message">
        <Paperclip size={28} />
        <span>ドロップして添付</span>
      </div>
    </div>
  {/if}
</section>

<style>
  .chat-view {
    position: relative;
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }
  .chat-view-drop-overlay {
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
  .chat-view-drop-message {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    color: var(--accent);
    font-weight: 600;
  }
</style>
