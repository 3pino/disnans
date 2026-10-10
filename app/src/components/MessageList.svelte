<script lang="ts">
  import { tick, untrack, type Snippet } from 'svelte';
  import ArrowDown from '@lucide/svelte/icons/arrow-down';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import MessageItem from './MessageItem.svelte';
  import Button from './ui/Button.svelte';
  import type { Message } from '../lib/protocol/Message';
  import type { Timeline } from '../lib/stores/timeline.svelte';
  import { dayLabel, sameDay } from '../lib/format';
  import { isContinuation } from '../lib/messageRows';
  import { ui } from '../lib/stores/ui.svelte';
  import { client } from '../lib/stores/client.svelte';
  import { prefs } from '../lib/stores/prefs.svelte';
  import { firstUnread, page, registerUnreadView, takePendingJump, unread } from '../lib/stores/unread.svelte';

  let {
    timeline,
    inThread = false,
    header,
    empty,
    active = false,
  }: {
    timeline: Timeline;
    inThread?: boolean;
    header?: Snippet;
    empty?: Snippet;
    /** 画面に見えている（見えていて一番下までスクロールしていれば既読にする） */
    active?: boolean;
  } = $props();

  const STICK_PX = 80;
  /** 最初の未読へ移動したときに、区切り線の上に空ける幅 */
  const UNREAD_TOP_PX = 48;

  let scroller: HTMLDivElement | undefined = $state();
  let content: HTMLDivElement | undefined = $state();
  let atBottom = $state(true);
  /** 「ここから未読」の区切り線を出すメッセージ。表示したときに決め、読んでいる間は動かさない */
  let separatorId = $state<string | null>(null);

  const all = $derived<Message[]>([...timeline.messages, ...timeline.pending]);
  /** 返信を受けているメッセージの ID（その返信が一覧にあるもの） */
  const repliedIds = $derived(new Set(all.map((m) => m.reply_to).filter((id): id is string => id !== null)));

  type Row = { msg: Message; grouped: boolean; day: string | null; replied: boolean };
  const rows = $derived.by<Row[]>(() => {
    const out: Row[] = [];
    let prev: Message | null = null;
    for (const m of all) {
      const newDay = !prev || !sameDay(prev.created_at, m.created_at);
      // 区切り線のあとは、投稿者の名前から出し直す
      const grouped = isContinuation(prev, m, newDay) && m.id !== separatorId;
      out.push({ msg: m, grouped, day: newDay ? dayLabel(m.created_at, ui.now) : null, replied: repliedIds.has(m.id) });
      prev = m;
    }
    return out;
  });

  function scrollToBottom(smooth = false) {
    if (!scroller) return;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
  }

  function updateAtBottom() {
    if (!scroller) return;
    atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STICK_PX;
  }

  function onscroll() {
    if (!scroller) return;
    updateAtBottom();
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

  // キーボードを出し入れして見えている高さが変わったときも、一番下にいたら下に張り付いたままにする
  // （描画のあとと、キーボードの動きが終わるころの2回）
  $effect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const keep = () => {
      if (atBottom) scrollToBottom();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      requestAnimationFrame(keep);
      timer = setTimeout(keep, 250);
    };
    vv.addEventListener('resize', onResize);
    return () => {
      vv.removeEventListener('resize', onResize);
      clearTimeout(timer);
    };
  });

  // タイムラインが切り替わったら一番下から
  $effect(() => {
    void timeline;
    atBottom = true;
    untrack(() => {
      separatorId = null;
      wasShowing = false;
    });
    void tick().then(() => scrollToBottom());
  });

  // ---- 未読 ----

  /** 見えていて、未読の位置を比べられる（区切り線の位置を決められる） */
  const showing = $derived(active && page.visible && timeline.loaded && unread.loaded);
  let wasShowing = false;

  function findFirstUnread(): string | null {
    return firstUnread(timeline.messages, unread.cursor(timeline.threadId), client.me?.id ?? null)?.id ?? null;
  }

  /** 区切り線が上から少し下に来るようにスクロールする。区切り線がなければ false */
  function scrollToSeparator(): boolean {
    const el = scroller?.querySelector<HTMLElement>('.message-list-unread-divider');
    if (!scroller || !el) return false;
    scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - UNREAD_TOP_PX;
    updateAtBottom();
    return true;
  }

  /** 区切り線（なければ一番下）へ移動する。描画を待ってからスクロールする */
  function jumpToSeparator(smooth = false) {
    // スクロールし終わるまでは既読にしない（一番下にいるとみなさない）
    if (separatorId !== null) atBottom = false;
    void tick().then(() => {
      if (separatorId !== null && scrollToSeparator()) return;
      atBottom = true;
      scrollToBottom(smooth);
    });
  }

  // 表示したときに区切り線の位置を決める。一番下が見えていて、画面にフォーカスがあれば既読にする
  $effect(() => {
    const isShowing = showing;
    const count = unread.count(timeline.threadId);
    const latest = timeline.messages.at(-1)?.id;
    const canMark = isShowing && page.active && atBottom;
    untrack(() => {
      if (isShowing && !wasShowing) {
        separatorId = findFirstUnread();
        // 開いたとき（と、移動を頼まれたとき）は最初の未読へ
        const requested = takePendingJump(timeline.threadId);
        if (separatorId !== null || requested) jumpToSeparator();
      } else if (isShowing && !canMark && separatorId === null && count > 0) {
        // 見えているが読んでいない（スクロールで上にいる、フォーカスがない）間に届いた
        separatorId = findFirstUnread();
      }
      wasShowing = isShowing;
      if (canMark && atBottom && latest) unread.markRead(timeline.threadId, latest);
    });
  });

  // 見えている間は、コマンドから「最初の未読へ」を受け付ける
  $effect(() => {
    if (!showing) return;
    const threadId = timeline.threadId;
    return untrack(() =>
      registerUnreadView(threadId, {
        scrollToFirstUnread: () => {
          const id = findFirstUnread();
          if (id !== null) separatorId = id;
          jumpToSeparator(true);
          return true;
        },
      }),
    );
  });
</script>

<div class="message-list" data-layout={prefs.messageLayout}>
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
        <Button onclick={() => timeline.load()}>再試行</Button>
      </div>
    {/if}
    {#if timeline.loaded && all.length === 0 && empty}
      {@render empty()}
    {/if}
    {#each rows as r (r.msg.id)}
      {#if r.day}
        <div class="message-list-day-divider"><span>{r.day}</span></div>
      {/if}
      {#if r.msg.id === separatorId}
        <div class="message-list-unread-divider" role="separator"><span>ここから未読</span></div>
      {/if}
      <MessageItem message={r.msg} grouped={r.grouped} replied={r.replied} {inThread} />
    {/each}
    <!-- 送信中の添付のアップロードの進み（送信中の仮表示は一番下に並ぶ） -->
    {#each timeline.pending as p (p.client_id)}
      {#each p.files.filter((f) => !f.attachment) as f (f.key)}
        <div class="message-list-upload" class:message-list-upload-error={!!f.error}>
          {#if f.preview}<img class="message-list-upload-thumb" src={f.preview} alt="" />{/if}
          <div class="message-list-upload-body">
            <span class="message-list-upload-name">{f.file.name}</span>
            <span class="message-list-upload-state muted">
              {#if f.error}{f.error}{:else if f.abort}{Math.round(f.progress * 100)}%{:else}準備中…{/if}
            </span>
            <div class="message-list-upload-bar"><div class="message-list-upload-fill" style:width="{Math.round(f.progress * 100)}%"></div></div>
          </div>
        </div>
      {/each}
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
  .message-list-unread-divider {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 8px 16px 4px;
    color: var(--danger);
    font-size: 12px;
    font-weight: 650;
  }
  .message-list-unread-divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--danger);
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
  /* 送信中の添付（アップロードの進み）。自分の発言と同じ側に出す */
  .message-list-upload {
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: 70%;
    margin: 4px 16px 4px auto;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    font-size: 12px;
  }
  /* 一覧のときは、本文と同じ左の位置に（アイコンの幅のぶん空ける） */
  .message-list[data-layout='list'] .message-list-upload {
    margin: 4px 16px 4px 64px;
  }
  .message-list-upload.message-list-upload-error {
    border-color: var(--danger);
  }
  .message-list-upload-thumb {
    width: 40px;
    height: 40px;
    flex: none;
    object-fit: cover;
    border-radius: 6px;
  }
  .message-list-upload-body {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    flex: 1;
  }
  .message-list-upload-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .message-list-upload-error .message-list-upload-state {
    color: var(--danger);
  }
  .message-list-upload-bar {
    height: 3px;
    border-radius: 2px;
    background: var(--surface-2);
    overflow: hidden;
  }
  .message-list-upload-fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.15s;
  }
</style>
