<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import MessageItem from './MessageItem.svelte';
  import Button from './ui/Button.svelte';
  import type { Message } from '../lib/protocol/Message';
  import { dayLabel, sameDay } from '../lib/format';
  import { jumpToMessage } from '../lib/jump';
  import { mentionsToText } from '../lib/markdown';
  import { matchRanges } from '../lib/search';
  import { threadTitle } from '../lib/thread';
  import { client } from '../lib/stores/client.svelte';
  import { prefs } from '../lib/stores/prefs.svelte';
  import { messageSearch as search } from '../lib/stores/search.svelte';
  import { threads } from '../lib/stores/threads.svelte';
  import { ui } from '../lib/stores/ui.svelte';

  // 検索中のメインのタイムライン。当たったメッセージだけを、チャットと同じ並び（古いものが上、下端から積み上がる）で出す。
  // 上へスクロールするとさらに古い結果を読み込む。押すと検索を抜けて、そのメッセージへ移る
  const HIGHLIGHT = 'search-hit';

  let scroller: HTMLDivElement | undefined = $state();
  let content: HTMLDivElement | undefined = $state();
  let atBottom = true;

  type Row = { msg: Message; day: string | null };
  const rows = $derived.by<Row[]>(() => {
    const out: Row[] = [];
    let prev: Message | null = null;
    for (const m of search.hits) {
      out.push({ msg: m, day: !prev || !sameDay(prev.created_at, m.created_at) ? dayLabel(m.created_at, ui.now) : null });
      prev = m;
    }
    return out;
  });

  /** 結果の場所の見出し（スレッドのものだけ。メインチャットは何も出さない） */
  function placeOf(hit: Message): string | null {
    if (!hit.thread_id) return null;
    const t = threads.get(hit.thread_id);
    if (!t) return 'スレッド';
    return threadTitle(t) ?? (mentionsToText(t.root.body, (id) => client.nameOf(id)).replace(/\s+/g, ' ').slice(0, 30) || 'スレッド');
  }

  function scrollToBottom() {
    scroller?.scrollTo({ top: scroller.scrollHeight, behavior: 'instant' });
  }

  function onscroll() {
    if (!scroller) return;
    atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    if (scroller.scrollTop < 400) void loadOlder();
  }

  async function loadOlder() {
    if (!scroller || !search.hasMore || search.loadingOlder) return;
    const h = scroller.scrollHeight;
    await search.loadOlder();
    await tick();
    // 上に足した分だけずらして、見ている位置を保つ
    if (scroller) scroller.scrollTop += scroller.scrollHeight - h;
  }

  // 新しい検索の結果が来たら一番下（新しい側）から見せる
  $effect(() => {
    void search.shown;
    untrack(() => (atBottom = true));
    void tick().then(scrollToBottom);
  });

  // 下に張り付いているときは、内容が増えても（画像の読み込みを含む）下を保つ。短くて上が空いているときは続きを読む
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

  // ---- ヒット箇所の強調（CSS Custom Highlight API。本文の描画には手を入れず、描画後の文字に重ねる） ----

  function paint() {
    if (!content || typeof CSS === 'undefined' || !CSS.highlights) return;
    const ranges: Range[] = [];
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.nodeValue ?? '';
      for (const [from, to] of matchRanges(text, search.shown)) {
        const r = new Range();
        r.setStart(n, from);
        r.setEnd(n, to);
        ranges.push(r);
      }
    }
    CSS.highlights.set(HIGHLIGHT, new Highlight(...ranges));
  }

  $effect(() => {
    if (!content) return;
    void rows;
    void search.shown;
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(paint);
    };
    schedule();
    // 本文の描画（画像・引用の読み込みなど）で文字が入れ替わるので、変わるたびに付け直す
    const mo = new MutationObserver(schedule);
    mo.observe(content, { childList: true, subtree: true, characterData: true });
    return () => {
      mo.disconnect();
      cancelAnimationFrame(raf);
    };
  });

  // 検索モードを抜けるとき（×・Esc・戻る・結果を選んだとき）に後片付けする
  onMount(() => () => {
    if (typeof CSS !== 'undefined' && CSS.highlights) CSS.highlights.delete(HIGHLIGHT);
    search.reset();
  });

  // ---- 移動 ----

  /** 表示の切り替えのあと、要素やデータが出そろうまで少し待つ（3秒まで） */
  async function until<T>(get: () => T | null | undefined): Promise<T | null> {
    const end = Date.now() + 3000;
    for (;;) {
      const v = get();
      if (v) return v;
      if (Date.now() > end) return null;
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  /** 選んだメッセージへ移動する。スレッドのものはスレッドを開く（モバイルでは全画面になる） */
  async function pick(hit: Message): Promise<void> {
    const threadId = hit.thread_id;
    ui.closeSearch();
    if (threadId) {
      ui.openThread(threadId);
    } else {
      ui.tab = 'chat';
      if (ui.isMobile) ui.closePanel();
    }
    const target = await until(() =>
      document.querySelector<HTMLElement>(threadId ? '.shell-thread-panel .message-list-scroller' : '#main-chat .message-list-scroller'),
    );
    if (!target) {
      ui.toast('メッセージを表示できませんでした', 'error');
      return;
    }
    const timeline = client.timeline(threadId);
    await until(() => timeline.loaded || !!timeline.error);
    await jumpToMessage(target, timeline, hit.id);
  }

  function onkeydown(e: KeyboardEvent, hit: Message) {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void pick(hit);
    }
  }
</script>

<div class="search-results" data-layout={prefs.messageLayout}>
  <div class="search-results-scroller scroll" bind:this={scroller} {onscroll}>
    <div class="search-results-content" bind:this={content}>
      {#if search.error}
        <div class="search-results-note search-results-error">
          検索できませんでした（{search.error}）
          <Button onclick={() => (search.hits.length > 0 ? void loadOlder() : search.retry())}>再試行</Button>
        </div>
      {/if}
      {#if search.loadingOlder}
        <div class="search-results-note"><LoaderCircle size={18} class="spin" /></div>
      {:else if search.hits.length > 0 && !search.hasMore}
        <div class="search-results-note">これより古い結果はありません</div>
      {/if}

      {#each rows as r (r.msg.id)}
        {#if r.day}
          <div class="search-results-day"><span>{r.day}</span></div>
        {/if}
        {@const place = placeOf(r.msg)}
        <div
          class="search-hit"
          role="button"
          tabindex="0"
          aria-label="このメッセージへ移動"
          onclick={() => void pick(r.msg)}
          onkeydown={(e) => onkeydown(e, r.msg)}
        >
          {#if place}<div class="search-hit-place">スレッド: {place}</div>{/if}
          <!-- 中の操作（リンク・ボタン・スワイプ）は効かせず、押したら移動する -->
          <div class="search-hit-body" inert>
            <MessageItem message={r.msg} inThread={!!r.msg.thread_id} />
          </div>
        </div>
      {/each}

      <!-- 状態の表示は一番下（入力欄のすぐ上）に出す -->
      {#if !search.active}
        <div class="search-results-note">言葉を入力すると、メインチャットとスレッドのメッセージを絞り込みます。</div>
      {:else if search.hits.length === 0 && !search.error}
        {#if search.loading || search.shown !== search.query.trim()}
          <div class="search-results-note"><LoaderCircle size={18} class="spin" />&nbsp;検索しています…</div>
        {:else}
          <div class="search-results-note">「{search.shown}」に一致するメッセージはありません</div>
        {/if}
      {:else if search.loading}
        <div class="search-results-note"><LoaderCircle size={18} class="spin" />&nbsp;検索しています…</div>
      {/if}
    </div>
  </div>
</div>

<style>
  .search-results {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .search-results-scroller {
    flex: 1;
    min-height: 0;
    overflow-anchor: none;
    overscroll-behavior: contain;
  }
  .search-results-content {
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    min-height: 100%;
    padding: 16px 0 12px;
  }
  .search-results-note {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 16px;
    color: var(--text-muted);
    font-size: 13px;
    text-align: center;
  }
  .search-results-error {
    color: var(--danger);
    font-size: 14px;
  }
  .search-results-day {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 16px 16px 4px;
    color: var(--text-muted);
    font-size: 12px;
    font-weight: 600;
  }
  .search-results-day::before,
  .search-results-day::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--border);
    opacity: 0.6;
  }
  .search-hit {
    cursor: pointer;
    outline: none;
  }
  .search-hit:hover,
  .search-hit:focus-visible {
    background: var(--surface);
  }
  .search-hit-place {
    padding: 4px 16px 0;
    color: var(--text-muted);
    font-size: 12px;
  }
</style>
