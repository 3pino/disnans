<script lang="ts">
  import Modal from './ui/Modal.svelte';
  import TextInput from './ui/TextInput.svelte';
  import SuggestList from './ui/SuggestList.svelte';
  import Button from './ui/Button.svelte';
  import { api } from '../lib/api';
  import { authorOf } from '../lib/author';
  import { formatStamp } from '../lib/format';
  import { jumpToMessage } from '../lib/jump';
  import { mentionsToText } from '../lib/markdown';
  import { SEARCH_DEBOUNCE_MS, SEARCH_PAGE, snippetSegments } from '../lib/search';
  import { threadTitle } from '../lib/thread';
  import type { Message } from '../lib/protocol/Message';
  import { client } from '../lib/stores/client.svelte';
  import { threads } from '../lib/stores/threads.svelte';
  import { ui } from '../lib/stores/ui.svelte';

  // メッセージ検索。入力が少し止まってから結果を出し、選ぶとそのメッセージへ移動する（スレッドのものはスレッドを開く）
  let { onclose }: { onclose: () => void } = $props();

  let query = $state('');
  /** 結果の検索語（入力中でも、結果が来るまでは前の語で出す） */
  let shown = $state('');
  let hits = $state<Message[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let hasMore = $state(false);
  let index = $state(0);
  let list: SuggestList<Message> | undefined = $state();
  /** 古い応答を捨てるための番号 */
  let seq = 0;

  /** 検索して結果を出す。before があれば、その続き（古いもの）を足す */
  async function run(q: string, before: string | null = null): Promise<void> {
    const mine = ++seq;
    loading = true;
    error = null;
    try {
      const page = await api.searchMessages({ q, before, limit: SEARCH_PAGE });
      if (mine !== seq) return;
      shown = q;
      hits = before ? [...hits, ...page] : page;
      hasMore = page.length >= SEARCH_PAGE;
    } catch (e) {
      if (mine !== seq) return;
      error = e instanceof Error ? e.message : String(e);
    } finally {
      if (mine === seq) loading = false;
    }
  }

  // 入力が止まってから検索する。語が変わったら、前の検索の応答は捨てる
  $effect(() => {
    const q = query.trim();
    if (!q) {
      seq++;
      hits = [];
      shown = '';
      hasMore = false;
      loading = false;
      error = null;
      return;
    }
    const timer = setTimeout(() => void run(q), SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      seq++;
      loading = false;
    };
  });

  // 結果が変わったら先頭を選ぶ
  $effect(() => {
    void hits;
    index = 0;
  });

  async function more(): Promise<void> {
    const last = hits.at(-1);
    if (last && !loading) await run(shown, last.id);
  }

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
    onclose();
    const threadId = hit.thread_id;
    if (threadId) {
      ui.openThread(threadId);
    } else {
      ui.tab = 'chat';
      if (ui.isMobile) ui.closePanel();
    }
    const scroller = await until(() =>
      document.querySelector<HTMLElement>(threadId ? '.shell-thread-panel .message-list-scroller' : '#main-chat .message-list-scroller'),
    );
    if (!scroller) {
      ui.toast('メッセージを表示できませんでした', 'error');
      return;
    }
    const timeline = client.timeline(threadId);
    await until(() => timeline.loaded || !!timeline.error);
    await jumpToMessage(scroller, timeline, hit.id);
  }

  function onkeydown(e: KeyboardEvent) {
    // IME 変換中の Enter は確定なので触らない
    if (e.isComposing || e.keyCode === 229) return;
    list?.keydown(e);
  }

  /** 結果の場所の見出し（メインチャット、またはスレッドのタイトル） */
  function placeOf(hit: Message): string {
    if (!hit.thread_id) return 'メインチャット';
    const t = threads.get(hit.thread_id);
    if (!t) return 'スレッド';
    return threadTitle(t) ?? (mentionsToText(t.root.body, (id) => client.nameOf(id)).replace(/\s+/g, ' ').slice(0, 30) || 'スレッド');
  }
</script>

<Modal title="メッセージを検索" {onclose} width={560}>
  <div class="message-search">
    <TextInput
      class="message-search-input"
      bind:value={query}
      placeholder="探す言葉（空白で区切ると、すべて含むものを探します）"
      aria-label="メッセージを検索"
      autocomplete="off"
      spellcheck={false}
      {onkeydown}
    />
    {#if error}
      <p class="message-search-error">{error}</p>
    {:else if hits.length > 0}
      <div class="message-search-results scroll">
        <SuggestList bind:this={list} bind:index class="message-search-list" label="検索結果" items={hits} key={(h) => h.id} onpick={(h) => void pick(h)} {onclose}>
          {#snippet item(h)}
            {@const segs = snippetSegments(mentionsToText(h.body, (id) => client.nameOf(id)), shown)}
            <span class="message-search-item">
              <span class="message-search-head">
                <span class="message-search-author">{authorOf(h, client.users).name}</span>
                <span class="message-search-place">{placeOf(h)}</span>
                <span class="message-search-time">{formatStamp(h.created_at, ui.now)}</span>
              </span>
              <span class="message-search-snippet">
                {#each segs as seg, si (si)}{#if seg.hit}<mark class="message-search-hit">{seg.text}</mark>{:else}{seg.text}{/if}{/each}
              </span>
            </span>
          {/snippet}
        </SuggestList>
      </div>
      {#if hasMore}
        <Button class="message-search-more" disabled={loading} onclick={() => void more()}>さらに前の結果を読む</Button>
      {/if}
    {:else if !query.trim()}
      <p class="muted message-search-empty">言葉を入力すると、メインチャットとスレッドのメッセージを探します。</p>
    {:else if loading || shown !== query.trim()}
      <p class="muted message-search-empty">検索しています…</p>
    {:else}
      <p class="muted message-search-empty">見つかりません</p>
    {/if}
  </div>
</Modal>

<style>
  .message-search {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .message-search > :global(.message-search-input) {
    width: 100%;
  }
  .message-search-results {
    max-height: min(420px, 60dvh);
  }
  /* 見た目は .suggest-list（app.css）。モーダルの中なので枠と影は付けない */
  .message-search-results > :global(.message-search-list) {
    padding: 0;
    border: none;
    box-shadow: none;
  }
  .message-search-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    width: 100%;
  }
  .message-search-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    font-size: 13px;
  }
  .message-search-author {
    font-weight: 600;
    flex: none;
  }
  .message-search-place {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-muted);
  }
  .message-search-time {
    margin-left: auto;
    flex: none;
    color: var(--text-muted);
  }
  .message-search-snippet {
    font-size: 14px;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .message-search-hit {
    padding: 0 2px;
    border-radius: 3px;
    background: var(--mention-soft);
    color: inherit;
  }
  .message-search > :global(.message-search-more) {
    align-self: center;
  }
  .message-search-empty,
  .message-search-error {
    margin: 0;
    padding: 8px;
    font-size: 14px;
  }
  .message-search-error {
    color: var(--danger);
  }
</style>
