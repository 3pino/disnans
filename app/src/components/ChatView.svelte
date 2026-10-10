<script lang="ts">
  import type { Snippet } from 'svelte';
  import Paperclip from '@lucide/svelte/icons/paperclip';
  import MessageList from './MessageList.svelte';
  import Composer from './Composer.svelte';
  import { client } from '../lib/stores/client.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { isLinuxDesktop } from '../lib/config';
  import { listenNativeDrop, pointInRect, readDroppedFiles } from '../lib/dropFiles';

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
  /** Linux: Tauri のドロップ（パス）でファイルをこの領域の上へ持ってきている最中 */
  let nativeOver = $state(false);
  let section: HTMLElement | undefined = $state();

  $effect(() => {
    if (client.ready && !timeline.loaded && !timeline.loading) void timeline.load();
  });

  // Linux では WebKitGTK の HTML5 のドロップで File が届かないため、Tauri のドロップ（パス）で受ける。
  // ドロップした位置がこのチャット領域の中のときだけ受ける（メインとスレッドは別の領域）
  $effect(() => {
    if (!isLinuxDesktop()) return;
    let stop: (() => void) | null = null;
    let alive = true;
    void listenNativeDrop((ev) => {
      if (!section) return;
      const inside = ev.position !== null && pointInRect(ev.position, section.getBoundingClientRect());
      if (ev.type === 'leave') {
        nativeOver = false;
      } else if (ev.type === 'drop') {
        nativeOver = false;
        if (inside && ev.paths.length) void addDroppedPaths(ev.paths);
      } else {
        // enter / over
        nativeOver = inside;
      }
    }).then((u) => {
      if (alive) stop = u;
      else u();
    });
    return () => {
      alive = false;
      stop?.();
      nativeOver = false;
    };
  });

  async function addDroppedPaths(paths: string[]) {
    const { files, failed } = await readDroppedFiles(paths);
    if (files.length) composer?.addFiles(files);
    for (const f of failed) ui.toast(`読み込めませんでした: ${f}`, 'error');
  }

  function hasFiles(e: DragEvent) {
    return [...(e.dataTransfer?.types ?? [])].includes('Files');
  }
</script>

<section
  bind:this={section}
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
    // Linux は上の Tauri のドロップで受けるので、ここでは受けない（同じファイルを二重に添付しないため）
    if (isLinuxDesktop()) return;
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) composer?.addFiles(files);
  }}
>
  <MessageList {timeline} inThread={threadId !== null} {header} {empty} {active} />
  <Composer bind:this={composer} {threadId} {placeholder} />

  {#if dragDepth > 0 || nativeOver}
    <div class="chat-view-drop-overlay" aria-hidden="true">
      <Paperclip size={56} />
      <span class="chat-view-drop-label">ここに添付</span>
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
  /* ドラッグ中の受け入れ先。チャット領域の真ん中に、半透明の幕と大きめのアイコン・文字を出す */
  .chat-view-drop-overlay {
    position: absolute;
    inset: 8px;
    z-index: 40;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 12px;
    border: 2px dashed color-mix(in oklch, var(--accent) 60%, transparent);
    border-radius: var(--radius);
    background: color-mix(in oklch, var(--bg) 72%, transparent);
    color: var(--accent);
    pointer-events: none;
  }
  .chat-view-drop-label {
    font-size: 20px;
    font-weight: 600;
  }
</style>
