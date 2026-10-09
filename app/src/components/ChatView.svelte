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
        <Paperclip size={14} />
        <span>ここに添付</span>
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
  /* ドラッグ中の受け入れ先。枠を薄く出し、上に小さなラベルを出すだけ（入力欄へ添付される） */
  .chat-view-drop-overlay {
    position: absolute;
    inset: 6px;
    z-index: 40;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 12px;
    border: 1px dashed color-mix(in oklch, var(--accent) 55%, transparent);
    border-radius: var(--radius);
    background: color-mix(in oklch, var(--bg) 35%, transparent);
    pointer-events: none;
  }
  .chat-view-drop-message {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 999px;
    background: var(--surface);
    box-shadow: var(--shadow);
    color: var(--accent);
    font-size: 12px;
    font-weight: 600;
  }
</style>
