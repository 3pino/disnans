<script lang="ts">
  import { tick, untrack, type Snippet } from 'svelte';
  import ArrowDown from '@lucide/svelte/icons/arrow-down';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import MessageItem from './MessageItem.svelte';
  import type { Message } from '../lib/protocol/Message';
  import type { Timeline } from '../lib/stores/timeline.svelte';
  import { dayLabel, sameDay } from '../lib/format';
  import { ui } from '../lib/stores/ui.svelte';

  let {
    timeline,
    inThread = false,
    header,
    empty,
  }: { timeline: Timeline; inThread?: boolean; header?: Snippet; empty?: Snippet } = $props();

  const GROUP_MS = 5 * 60_000;
  const STICK_PX = 80;

  let scroller: HTMLDivElement | undefined = $state();
  let content: HTMLDivElement | undefined = $state();
  let atBottom = $state(true);

  const all = $derived<Message[]>([...timeline.messages, ...timeline.pending]);

  type Row = { msg: Message; grouped: boolean; day: string | null };
  const rows = $derived.by<Row[]>(() => {
    const out: Row[] = [];
    let prev: Message | null = null;
    for (const m of all) {
      const newDay = !prev || !sameDay(prev.created_at, m.created_at);
      const grouped =
        !!prev &&
        !newDay &&
        prev.author_id === m.author_id &&
        m.created_at - prev.created_at < GROUP_MS &&
        !prev.thread &&
        !m.thread;
      out.push({ msg: m, grouped, day: newDay ? dayLabel(m.created_at, ui.now) : null });
      prev = m;
    }
    return out;
  });

  function scrollToBottom(smooth = false) {
    if (!scroller) return;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
  }

  function onscroll() {
    if (!scroller) return;
    atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STICK_PX;
    if (scroller.scrollTop < 400) void loadOlder();
  }

  async function loadOlder() {
    if (!scroller || timeline.loadingOlder || !timeline.hasMore || !timeline.loaded) return;
    const h = scroller.scrollHeight;
    await timeline.loadOlder();
    await tick();
    // 上に足した分だけずらして、見ている位置を保つ
    if (scroller) scroller.scrollTop += scroller.scrollHeight - h;
  }

  // 自分が送ったときは必ず下へ
  let lastPending = 0;
  $effect(() => {
    const n = timeline.pending.length;
    if (n > lastPending) {
      untrack(() => (atBottom = true));
      void tick().then(() => scrollToBottom());
    }
    lastPending = n;
  });

  // 下に張り付いているときは、内容が増えても（画像の読み込みを含む）下を保つ
  $effect(() => {
    if (!content || !scroller) return;
    const ro = new ResizeObserver(() => {
      if (atBottom) scrollToBottom();
      else if (scroller && scroller.scrollTop < 400) void loadOlder();
    });
    ro.observe(content);
    ro.observe(scroller);
    return () => ro.disconnect();
  });

  // タイムラインが切り替わったら一番下から
  $effect(() => {
    void timeline;
    atBottom = true;
    void tick().then(() => scrollToBottom());
  });
</script>

<div class="message-list">
<div class="message-list-scroller scroll" bind:this={scroller} {onscroll}>
  <div class="message-list-content" bind:this={content}>
    {#if header}{@render header()}{/if}
    {#if timeline.loadingOlder || (timeline.loading && !timeline.loaded)}
      <div class="message-list-loading"><LoaderCircle size={18} class="spin" /></div>
    {:else if timeline.loaded && !timeline.hasMore && !header}
      <div class="message-list-start">ここが始まりです</div>
    {/if}
    {#if timeline.error && !timeline.loaded}
      <div class="message-list-error">
        読み込めませんでした（{timeline.error}）
        <button type="button" class="btn" onclick={() => timeline.load()}>再試行</button>
      </div>
    {/if}
    {#if timeline.loaded && all.length === 0 && empty}
      {@render empty()}
    {/if}
    {#each rows as r (r.msg.id)}
      {#if r.day}
        <div class="message-list-day-divider"><span>{r.day}</span></div>
      {/if}
      <MessageItem message={r.msg} grouped={r.grouped} {inThread} />
    {/each}
  </div>
</div>

{#if !atBottom}
  <button type="button" class="message-list-jump-latest" onclick={() => scrollToBottom(true)} aria-label="最新へ移動">
    <ArrowDown size={18} />
  </button>
{/if}
</div>

<style>
  .message-list {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .message-list-scroller {
    flex: 1;
    min-height: 0;
    overflow-anchor: none;
    overscroll-behavior: contain;
  }
  .message-list-content {
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    min-height: 100%;
    padding: 16px 0 12px;
  }
  .message-list-loading,
  .message-list-start {
    display: grid;
    place-items: center;
    padding: 16px;
    color: var(--text-muted);
    font-size: 13px;
  }
  .message-list-error {
    display: flex;
    gap: 10px;
    align-items: center;
    justify-content: center;
    padding: 16px;
    color: var(--danger);
    font-size: 14px;
  }
  .message-list-day-divider {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 16px 16px 4px;
    color: var(--text-muted);
    font-size: 12px;
    font-weight: 600;
  }
  .message-list-day-divider::before,
  .message-list-day-divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--border);
    opacity: 0.6;
  }
  .message-list-jump-latest {
    position: absolute;
    right: 20px;
    bottom: 12px;
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    border-radius: 50%;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow);
    z-index: 6;
  }
</style>
