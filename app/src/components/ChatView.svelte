<script lang="ts">
  import type { Snippet } from 'svelte';
  import Paperclip from '@lucide/svelte/icons/paperclip';
  import MessageList from './MessageList.svelte';
  import SearchResults from './SearchResults.svelte';
  import Composer from './Composer.svelte';
  import { client } from '../lib/stores/client.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { needsFirstLoad } from '../lib/stores/timeline.svelte';
  import { isLinuxDesktop } from '../lib/platform';
  import { listenNativeDrop, pointInRect, readDroppedFiles } from '../lib/dropFiles';

  let {
    placeholder,
    header,
    empty,
    active = false,
  }: {
    placeholder: string;
    header?: Snippet;
    empty?: Snippet;
    /** 画面に見えている（見えていて一番下までスクロールしていれば既読にする） */
    active?: boolean;
  } = $props();

  const timeline = $derived(client.timeline());
  let composer: Composer | undefined = $state();
  let dragDepth = $state(0);
  /** Linux: Tauri のドロップ（パス）でファイルをこの領域の上へ持ってきている最中 */
  let nativeOver = $state(false);
  let section: HTMLElement | undefined = $state();

  // 最初の 1 ページ。失敗したら読み直さない（画面の再試行・接続が戻ったとき。needsFirstLoad）
  $effect(() => {
    if (needsFirstLoad(client.ready, timeline)) void timeline.load();
  });

  // Linux では WebKitGTK の HTML5 のドロップで File が届かないため、Tauri のドロップ（パス）で受ける。
  // ドロップした位置がこのチャット領域の中のときだけ受ける（overChat）
  $effect(() => {
    if (!isLinuxDesktop()) return;
    let stop: (() => void) | null = null;
    let alive = true;
    void listenNativeDrop((ev) => {
      if (!section) return;
      const inside = ev.position !== null && overChat(ev.position, section);
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

  /**
   * 点がこのチャットの一番手前にあるか。矩形だけでは、前に出ているエクスプローラーや画面の下にあるチャットも当たるため、
   * 点の位置で一番手前の要素がこのチャットの中にあるかも確かめる（前に出ているものへ落としたら、チャットへ添付しない）
   */
  function overChat(p: { x: number; y: number }, el: HTMLElement): boolean {
    if (!pointInRect(p, el.getBoundingClientRect())) return false;
    const top = document.elementFromPoint(p.x, p.y);
    return !!top && top.closest('.chat-view') === el;
  }

  async function addDroppedPaths(paths: string[]) {
    const { files, failed } = await readDroppedFiles(paths);
    if (files.length) composer?.addFiles(files);
    for (const f of failed) ui.toast(`読み込めませんでした: ${f}`, 'error');
  }

  /** Files が含まれ、かつエクスプローラーの内部 DnD でない（内部 DnD は Files 型を持たないが念のため） */
  function hasFiles(e: DragEvent) {
    const types = [...(e.dataTransfer?.types ?? [])];
    return types.includes('Files') && !types.includes('application/x-disnans-explorer');
  }
</script>

<section
  bind:this={section}
  class="chat-view"
  aria-label="チャット"
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
  <!-- 検索中は、メインのタイムラインを検索に当たったメッセージだけに絞り込む（入力欄は Composer が検索モードになる） -->
  {#if ui.searchOpen}
    <SearchResults />
  {:else}
    <MessageList {timeline} {header} {empty} {active} />
  {/if}
  <Composer bind:this={composer} {placeholder} />

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
    gap: var(--space-6);
    border: 2px dashed color-mix(in oklch, var(--accent) 60%, transparent);
    border-radius: var(--radius);
    background: color-mix(in oklch, var(--bg) 72%, transparent);
    color: var(--accent);
    pointer-events: none;
  }
  .chat-view-drop-label {
    font-size: var(--fs-xl);
    font-weight: var(--fw-semibold);
  }
</style>
