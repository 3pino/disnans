<script lang="ts">
  import SmilePlus from '@lucide/svelte/icons/smile-plus';
  import MessageSquare from '@lucide/svelte/icons/message-square';
  import MessagesSquare from '@lucide/svelte/icons/messages-square';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Copy from '@lucide/svelte/icons/copy';
  import Reply from '@lucide/svelte/icons/reply';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import X from '@lucide/svelte/icons/x';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import AuthorAvatar from './AuthorAvatar.svelte';
  import Markdown from './Markdown.svelte';
  import Attachments from './Attachments.svelte';
  import Reactions from './Reactions.svelte';
  import EmojiPicker from './EmojiPicker.svelte';
  import MessageInput from './MessageInput.svelte';
  import ActionSheet from './ActionSheet.svelte';
  import MessageCard from './MessageCard.svelte';
  import Button from './ui/Button.svelte';
  import IconButton from './ui/IconButton.svelte';
  import type { Message } from '../lib/protocol/Message';
  import type { PendingMessage } from '../lib/stores/timeline.svelte';
  import { client } from '../lib/stores/client.svelte';
  import { authorOf, isOwnMessage } from '../lib/author';
  import { ui } from '../lib/stores/ui.svelte';
  import { prefs } from '../lib/stores/prefs.svelte';
  import { enterComboLabel, sendCombos } from '../lib/enterKeys';
  import { unread as unreadStore } from '../lib/stores/unread.svelte';
  import { formatFull, formatStamp, formatTime, relative } from '../lib/format';
  import { QUICK_REACTIONS } from '../lib/emoji';
  import { extractMentions } from '../lib/markdown';
  import { copyText } from '../lib/clipboard';
  import { swipeAxis, swipeOffset, swipeProgress, swipeTriggered, type SwipeAxis } from '../lib/swipe';

  let {
    message,
    grouped = false,
    inThread = false,
  }: {
    message: Message | PendingMessage;
    grouped?: boolean;
    /** スレッドの中（返信）。ここからはスレッドを作れない */
    inThread?: boolean;
  } = $props();

  /** 吹き出しのときの、他人の発言のアイコンの大きさ（px）。ふだんの半分くらい */
  const AVATAR_PX = 20;
  /** リストのときのアイコンの大きさ（px） */
  const AVATAR_LIST_PX = 36;

  /** 表示の仕方（設定）。吹き出しのときだけ、自分の発言を右に寄せ、時刻を吹き出しの横に出す */
  const layout = $derived(prefs.messageLayout);
  const bubble = $derived(layout === 'bubble');
  const pending = $derived('client_id' in message ? (message as PendingMessage) : null);
  /** 投稿者の表示（ボットなら名前とプラグインのアイコン） */
  const author = $derived(authorOf(message, client.users));
  /** 自分の発言（吹き出しの右側）。ボットの発言は、自分が実行したものでも他人の発言として出す */
  const isMine = $derived(isOwnMessage(message, client.me?.id));
  /** 削除できるか（自分が投稿者のもの。ボットの発言も、自分が実行したものなら削除できる） */
  const deletable = $derived(!!client.me && client.me.id === message.author_id);
  const mentionsMe = $derived(!!client.me && extractMentions(message.body).includes(client.me.id));
  const editing = $derived(ui.editing === message.id && !pending && !message.card);
  const canThread = $derived(!inThread && !pending && message.thread_id === null);
  /** このメッセージが起点のスレッドの未読数 */
  const unread = $derived(message.thread ? unreadStore.count(message.id) : 0);
  /** プラグインのカードとボットの発言は本文を編集できない（削除はできる） */
  const canEdit = $derived(isMine && !message.card && !author.isBot);
  /** 本文のコピー（カードや本文のない発言は対象外） */
  const canCopy = $derived(!pending && !message.card && message.body.length > 0);
  /** 左へのスワイプで返信できるか（長押しメニューの「スレッドで返信」と同じ） */
  const canSwipe = $derived(canThread && !editing);

  /** 一覧のとき、名前と時刻（ヘッダー）を出しているか。アイコンを押すと出し入れする（既定は隠す） */
  let headerShown = $state(false);
  /** アイコンで名前と時刻を出し入れできるか（一覧のグループ先頭の発言だけ。吹き出しは対象外） */
  const headerToggle = $derived(!bubble && !grouped);

  let picker = $state<DOMRect | null>(null);
  let sheet = $state(false);
  let editor: MessageInput | undefined = $state();
  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let pressFired = false;

  // ---- スワイプ（左へ動かして返信）。指の追跡は非リアクティブに持ち、描画に要る値だけ state にする ----
  let swipeFrom: { x: number; y: number } | null = null;
  let swipeAxisNow: SwipeAxis | null = null;
  /** 指が開始点から横へ動いた量（左が負） */
  let dragDx = $state(0);
  let swiping = $state(false);
  const swipeX = $derived(swipeOffset(dragDx));
  const armed = $derived(swipeTriggered(dragDx));

  function toggleHeader() {
    headerShown = !headerShown;
  }

  function onGutterKeydown(e: KeyboardEvent) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    toggleHeader();
  }

  function saveEdit() {
    if (!editor) return;
    const body = editor.getBody();
    if (body === message.body) {
      ui.editing = null;
      return;
    }
    if (!body && message.attachments.length === 0) {
      ui.editing = null;
      void remove();
      return;
    }
    client.editMessage(message, body);
    ui.editing = null;
  }

  async function remove() {
    const ok = await ui.confirm({
      title: 'メッセージを削除しますか？',
      body: message.thread
        ? 'このメッセージから始まったスレッドの返信もすべて削除されます。元には戻せません。'
        : message.card
          ? 'このカードのセッション（プラグインの状態）も削除されます。元には戻せません。'
          : '削除すると元には戻せません。',
      okLabel: '削除',
      danger: true,
    });
    if (ok) client.deleteMessage(message);
  }

  async function copyBody() {
    if (!canCopy) return;
    if (await copyText(message.body)) ui.toast('コピーしました');
    else ui.toast('コピーできませんでした', 'error');
  }

  function startPress(e: TouchEvent) {
    if (pending || editing || e.touches.length !== 1) return;
    pressFired = false;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      pressFired = true;
      navigator.vibrate?.(10);
      sheet = true;
    }, 450);
  }
  function cancelPress() {
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = null;
  }
  function endPress(e: TouchEvent) {
    cancelPress();
    // 長押しで開いたシートを、指を離したときのクリックで閉じないようにする
    if (pressFired && e.cancelable) e.preventDefault();
    pressFired = false;
  }

  function resetSwipe() {
    swipeFrom = null;
    swipeAxisNow = null;
    swiping = false;
    dragDx = 0;
  }

  function onTouchStart(e: TouchEvent) {
    startPress(e);
    const t = e.touches[0];
    swipeFrom = e.touches.length === 1 && t && canSwipe ? { x: t.clientX, y: t.clientY } : null;
    swipeAxisNow = null;
    dragDx = 0;
    swiping = false;
  }

  function onTouchMove(e: TouchEvent) {
    cancelPress();
    const t = e.touches[0];
    if (!swipeFrom || e.touches.length !== 1 || !t) return;
    const dx = t.clientX - swipeFrom.x;
    const dy = t.clientY - swipeFrom.y;
    if (swipeAxisNow === null) {
      swipeAxisNow = swipeAxis(dx, dy);
      if (swipeAxisNow === null) return;
    }
    // 縦に動いたら（スクロール）スワイプにはしない
    if (swipeAxisNow !== 'x') return;
    swiping = true;
    dragDx = dx;
  }

  function onTouchEnd(e: TouchEvent) {
    endPress(e);
    if (swipeAxisNow === 'x' && swipeTriggered(dragDx)) {
      navigator.vibrate?.(10);
      client.openThreadFrom(message);
    }
    resetSwipe();
  }

  function onTouchCancel() {
    cancelPress();
    resetSwipe();
  }

  $effect(() => {
    if (editing) queueMicrotask(() => editor?.focus());
  });
</script>

{#snippet edited()}
  <span class="message-edited" title={message.edited_at ? formatFull(message.edited_at) : undefined}>（編集済み）</span>
{/snippet}

{#snippet timeTag(cls: string, text: string)}
  <time class={cls} datetime={new Date(message.created_at).toISOString()} title={formatFull(message.created_at)}>{text}</time>
{/snippet}

<!-- 吹き出しの横の時刻（続きの発言は、ホバーしたときだけ出す） -->
{#snippet stamp()}
  {#if grouped}
    {@render timeTag('message-hover-time', formatTime(message.created_at))}
  {:else}
    {@render timeTag('message-time', formatStamp(message.created_at, ui.now))}
  {/if}
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="message-item"
  data-layout={layout}
  class:message-item-mine={isMine}
  class:message-item-grouped={grouped}
  class:message-item-pending={!!pending}
  class:message-item-failed={pending?.failed}
  class:message-item-mentioned={mentionsMe}
  class:message-item-editing={editing}
  class:message-item-swiping={swiping}
  class:message-item-armed={armed}
  data-id={message.id}
  ontouchstart={onTouchStart}
  ontouchend={onTouchEnd}
  ontouchmove={onTouchMove}
  ontouchcancel={onTouchCancel}
  oncontextmenu={(e) => {
    if (ui.isMobile && !pending) {
      e.preventDefault();
      sheet = true;
    }
  }}
>
  {#if !bubble || !isMine}
    <!-- 一覧の先頭の発言のアイコンは、押すと名前と時刻を出し入れする（長押しとスワイプは上のタッチ処理で扱う） -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="message-gutter"
      class:message-gutter-toggle={headerToggle}
      role={headerToggle ? 'button' : undefined}
      tabindex={headerToggle ? 0 : undefined}
      aria-pressed={headerToggle ? headerShown : undefined}
      aria-label={headerToggle ? '名前と時刻を表示' : undefined}
      onclick={headerToggle ? toggleHeader : undefined}
      onkeydown={headerToggle ? onGutterKeydown : undefined}
    >
      {#if grouped}
        <!-- 一覧の続きの発言は、ホバーしたときだけ左に時刻を出す -->
        {#if !bubble}{@render timeTag('message-hover-time', formatTime(message.created_at))}{/if}
      {:else}
        <AuthorAvatar {author} user={client.user(message.author_id)} id={message.author_id} size={bubble ? AVATAR_PX : AVATAR_LIST_PX} />
      {/if}
    </div>
  {/if}

  <div class="message-column">
    {#if bubble}
      {#if !isMine && !grouped}
        <div class="message-author">
          {author.name}{#if author.isBot}<span class="message-bot-badge">BOT</span>{/if}
        </div>
      {/if}
    {:else if !grouped && headerShown}
      <div class="message-header">
        <span class="message-author">{author.name}</span>
        {#if author.isBot}<span class="message-bot-badge">BOT</span>{/if}
        {@render timeTag('message-time', formatStamp(message.created_at, ui.now))}
      </div>
    {/if}

    <div class="message-line">
      {#if bubble && isMine}{@render stamp()}{/if}

      <!-- 本文（吹き出し）と、その下の付属物（リアクション・カードなど）。スワイプではまとめて動く -->
      <div class="message-stack" class:message-stack-editing={editing} style:transform="translateX({swipeX}px)">
        {#if editing}
          <div class="message-editor">
            <MessageInput
              bind:this={editor}
              initial={message.body}
              onsubmit={saveEdit}
              oncancel={() => (ui.editing = null)}
            />
          </div>
          <div class="message-edit-hint">
            {#if ui.isMobile}
              <Button onclick={() => (ui.editing = null)}>キャンセル</Button>
              <Button variant="primary" onclick={saveEdit}>保存</Button>
            {:else}
              {@const saveKey = sendCombos(prefs.enterKeys)[0]}
              <!-- 保存のキーは設定（入力欄のキー）の「送信」。なければボタンだけ -->
              Esc で<button type="button" class="message-link-button" onclick={() => (ui.editing = null)}>キャンセル</button>・{saveKey
                ? `${enterComboLabel(saveKey)} で`
                : ''}<button type="button" class="message-link-button" onclick={saveEdit}>保存</button>
            {/if}
          </div>
        {:else}
          {#if message.card}
            <!-- プラグインのセッションのカード。吹き出しの代わりに、その下に出す -->
            <MessageCard card={message.card} />
          {:else if message.body}
            <div class="message-bubble" class:message-bubble-mine={bubble && isMine} class:message-bubble-other={bubble && !isMine}>
              <div class="message-body">
                <Markdown body={message.body} suffix={message.edited_at ? edited : undefined} />
              </div>
            </div>
          {/if}
          {#if message.attachments.length > 0}
            <Attachments attachments={message.attachments} />
          {/if}
        {/if}

        {#if pending?.failed}
          <div class="message-send-failed">
            送信できませんでした
            <button type="button" class="message-link-button" onclick={() => client.retry(message.thread_id, pending.client_id)}
              ><RefreshCw size={13} />再送</button
            >
            <button
              type="button"
              class="message-link-button"
              onclick={() => client.timeline(message.thread_id).discardPending(pending.client_id)}><X size={13} />取り消す</button
            >
          </div>
        {/if}

        <Reactions {message} onaddclick={(r) => (picker = r)} />

        {#if message.thread && !inThread}
          <button type="button" class="message-thread-link" onclick={() => ui.openThread(message.id)}>
            <MessagesSquare size={15} />
            {#if message.thread.reply_count > 0}
              <span class="message-thread-link-count">{message.thread.reply_count}件の返信</span>
              {#if message.thread.last_reply_at}
                <span class="muted message-thread-link-last-reply">最終 {relative(message.thread.last_reply_at, ui.now)}</span>
              {/if}
            {:else}
              <span class="message-thread-link-count">スレッドで返信</span>
            {/if}
            {#if unread > 0}<span class="badge message-thread-link-unread">{unread}</span>{/if}
            <ChevronRight size={14} />
          </button>
        {/if}
      </div>

      {#if bubble && !isMine}{@render stamp()}{/if}
    </div>
  </div>

  {#if canSwipe && !pending}
    <!-- スワイプで返信するときに、左の端に出る返信アイコン -->
    <span class="message-swipe-hint" aria-hidden="true" style:opacity={swipeProgress(dragDx)}><Reply size={16} /></span>
  {/if}

  {#if !pending && !editing}
    <div class="message-toolbar" role="toolbar" aria-label="メッセージの操作">
      {#each QUICK_REACTIONS.slice(0, 3) as e (e)}
        <IconButton class="message-toolbar-emoji" label="{e} でリアクション" onclick={() => client.toggleReaction(message, e)}>{e}</IconButton>
      {/each}
      <IconButton label="リアクション" title="リアクション" onclick={(e) => (picker = e.currentTarget.getBoundingClientRect())}
        ><SmilePlus size={17} /></IconButton
      >
      {#if canThread}
        <IconButton
          label={message.thread ? 'スレッドを開く' : 'スレッドを作る'}
          title={message.thread ? 'スレッドを開く' : 'スレッドで返信'}
          onclick={() => client.openThreadFrom(message)}><MessageSquare size={17} /></IconButton
        >
      {/if}
      {#if canCopy}
        <IconButton label="コピー" title="コピー" onclick={copyBody}><Copy size={16} /></IconButton>
      {/if}
      {#if canEdit}
        <IconButton label="編集" title="編集" onclick={() => (ui.editing = message.id)}><Pencil size={16} /></IconButton>
      {/if}
      {#if deletable}
        <IconButton class="message-toolbar-delete" label="削除" title="削除" onclick={remove}><Trash2 size={16} /></IconButton>
      {/if}
    </div>
  {/if}
</div>

{#if picker}
  <EmojiPicker
    anchor={picker}
    onpick={(e) => {
      client.toggleReaction(message, e);
      picker = null;
    }}
    onclose={() => (picker = null)}
  />
{/if}

{#if sheet}
  <ActionSheet
    onclose={() => (sheet = false)}
    reactions={QUICK_REACTIONS}
    onreact={(e) => client.toggleReaction(message, e)}
    onmorereactions={() => (picker = new DOMRect(window.innerWidth / 2 + 140, window.innerHeight / 3, 0, 0))}
    items={[
      ...(canCopy ? [{ label: 'コピー', icon: Copy, run: copyBody }] : []),
      ...(canThread
        ? [{ label: message.thread ? 'スレッドを開く' : 'スレッドで返信', icon: MessageSquare, run: () => client.openThreadFrom(message) }]
        : []),
      ...(canEdit ? [{ label: '編集', icon: Pencil, run: () => (ui.editing = message.id) }] : []),
      ...(deletable ? [{ label: '削除', icon: Trash2, danger: true, run: remove }] : []),
    ]}
  />
{/if}

<style>
  .message-item {
    /* 自分の吹き出しの左に残す幅（時刻を含む）。吹き出しのときだけ使う */
    --mine-gap: 72px;
    position: relative;
    display: flex;
    gap: 8px;
    padding: 6px 16px 4px;
    margin-top: 6px;
    /* 横方向の操作（スワイプで返信）は自分で受け、縦のスクロールはそのまま */
    touch-action: pan-y;
  }
  .message-item[data-layout='list'] {
    gap: 12px;
  }
  .message-item.message-item-grouped {
    margin-top: 0;
    padding-top: 1px;
  }
  .message-item:hover {
    background: color-mix(in oklch, var(--surface) 55%, transparent);
  }
  .message-item.message-item-mentioned {
    background: var(--mention-soft);
    box-shadow: inset 2px 0 0 var(--mention);
  }
  .message-item.message-item-editing {
    background: var(--accent-soft);
  }
  .message-item.message-item-pending .message-stack {
    opacity: 0.6;
  }
  .message-item.message-item-failed .message-stack {
    opacity: 1;
  }
  .message-gutter {
    width: 20px;
    flex: none;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 2px;
  }
  .message-item[data-layout='list'] .message-gutter {
    width: 36px;
    padding-top: 0;
  }
  /* 一覧の先頭の発言のアイコンは、押して名前と時刻を出し入れできる */
  .message-gutter-toggle {
    cursor: pointer;
    border-radius: 50%;
    -webkit-tap-highlight-color: transparent;
  }
  .message-gutter-toggle:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .message-column {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  /* 時刻は、どちらの表示でも選べないように（長押しで文字を選ばないように） */
  .message-item time {
    flex: none;
    -webkit-user-select: none;
    user-select: none;
    color: var(--text-muted);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .message-hover-time {
    visibility: hidden;
  }
  .message-item:hover .message-hover-time {
    visibility: visible;
  }
  /* 一覧: 名前と時刻を上に並べる（Slack 風）。続きの発言は名前を省く */
  .message-header {
    display: flex;
    align-items: baseline;
    gap: 8px;
    line-height: 1.3;
    margin-bottom: 2px;
  }
  .message-header .message-time {
    font-size: 12px;
  }
  .message-item[data-layout='list'] .message-hover-time {
    font-size: 11px;
    line-height: 23px;
  }
  .message-author {
    font-weight: 650;
    line-height: 1.3;
  }
  /* ボットの発言の印。目立たせず、灰色の小さな札にする */
  .message-bot-badge {
    display: inline-block;
    margin-left: 6px;
    padding: 0 5px;
    border-radius: 4px;
    background: var(--surface-2);
    color: var(--text-muted);
    font-size: 10px;
    font-weight: 600;
    line-height: 15px;
    letter-spacing: 0.04em;
    vertical-align: 1px;
  }
  /* 吹き出し: 相手の名前は吹き出しの上に小さく */
  .message-item[data-layout='bubble'] .message-author {
    font-size: 11px;
    margin: 0 0 2px 2px;
  }
  .message-line {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    min-width: 0;
  }
  .message-item[data-layout='list'] .message-line {
    display: block;
  }
  .message-item[data-layout='bubble'] .message-line time {
    font-size: 11px;
    line-height: 1;
    margin-bottom: 2px;
  }
  .message-item[data-layout='bubble'].message-item-mine .message-line {
    justify-content: flex-end;
  }
  .message-stack {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    min-width: 0;
    max-width: 75%;
    transition: transform 0.2s ease-out;
  }
  /* 一覧: 本文は行の幅いっぱい。カードや添付は、ふつうの大きさのまま */
  .message-item[data-layout='list'] .message-stack {
    width: 100%;
    max-width: none;
  }
  /* 吹き出し・自分の発言は横幅を固定する（右寄せで幅が揃わないと読みにくいので）。左に --mine-gap だけ空け、文字は左寄せ。
     吹き出しとカードは幅いっぱいに広げ、写真などはそのままの大きさで右に寄せる */
  .message-item[data-layout='bubble'].message-item-mine .message-stack:not(.message-stack-editing) {
    align-items: flex-end;
    width: calc(100% - var(--mine-gap));
    max-width: none;
  }
  .message-item[data-layout='bubble'].message-item-mine .message-bubble {
    align-self: stretch;
  }
  .message-item[data-layout='bubble'].message-item-mine .message-stack > :global(.message-card) {
    align-self: stretch;
    max-width: none;
  }
  .message-stack.message-stack-editing {
    max-width: 100%;
    width: 100%;
  }
  .message-item.message-item-swiping .message-stack {
    transition: none;
  }
  .message-bubble {
    max-width: 100%;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .message-bubble.message-bubble-mine,
  .message-bubble.message-bubble-other {
    padding: 7px 12px;
    border-radius: 16px;
  }
  /* 自分の発言：アクセント色を薄く混ぜた、右側の吹き出し */
  .message-bubble.message-bubble-mine {
    background: color-mix(in oklch, var(--accent) 16%, var(--surface));
    border-bottom-right-radius: 4px;
  }
  /* 他人の発言：灰色の、左寄せの吹き出し */
  .message-bubble.message-bubble-other {
    background: var(--surface-2);
    border-bottom-left-radius: 4px;
  }
  .message-body {
    min-width: 0;
  }
  .message-edited {
    font-size: 11px;
    color: var(--text-muted);
  }
  .message-editor {
    display: flex;
    width: 100%;
    margin-top: 2px;
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-hover);
    background: var(--bg);
  }
  .message-edit-hint {
    display: flex;
    gap: 2px;
    align-items: center;
    flex-wrap: wrap;
    margin-top: 4px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .message-edit-hint > :global(.btn) {
    height: 32px;
    margin-right: 6px;
  }
  .message-link-button {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 0 3px;
    border: none;
    background: none;
    color: var(--accent);
    font-size: inherit;
  }
  .message-link-button:hover {
    text-decoration: underline;
  }
  .message-send-failed {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 2px;
    color: var(--danger);
    font-size: 12px;
  }
  .message-thread-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
    padding: 4px 10px 4px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--accent);
    font-size: 13px;
  }
  .message-thread-link:hover {
    border-color: var(--border-hover);
  }
  .message-thread-link .message-thread-link-count {
    font-weight: 600;
  }
  .message-thread-link .muted {
    font-size: 12px;
  }
  /* 付属物（リアクションの並び）は、吹き出しと同じ側に寄せる */
  .message-item[data-layout='bubble'].message-item-mine :global(.reactions) {
    justify-content: flex-end;
  }
  .message-swipe-hint {
    position: absolute;
    right: 16px;
    top: 50%;
    z-index: 1;
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    margin-top: -15px;
    border-radius: 50%;
    background: var(--surface-2);
    color: var(--accent);
    pointer-events: none;
    transition:
      background 0.15s,
      color 0.15s,
      transform 0.15s;
  }
  .message-item.message-item-armed .message-swipe-hint {
    background: var(--accent);
    color: var(--on-accent);
    transform: scale(1.12);
  }
  .message-toolbar {
    position: absolute;
    top: -14px;
    right: 16px;
    display: none;
    gap: 1px;
    padding: 2px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow);
    z-index: 5;
  }
  .message-toolbar > :global(.icon-btn) {
    width: 30px;
    height: 30px;
  }
  .message-toolbar > :global(.message-toolbar-emoji) {
    font-size: 16px;
  }
  .message-toolbar > :global(.message-toolbar-delete:hover) {
    color: var(--danger);
    background: var(--danger-soft);
  }
  .message-item:hover .message-toolbar,
  .message-item:focus-within .message-toolbar {
    display: flex;
  }
  @media (hover: none) {
    .message-item:hover .message-toolbar,
    .message-item:focus-within .message-toolbar {
      display: none;
    }
    .message-item:hover {
      background: none;
    }
    .message-item {
      -webkit-touch-callout: none;
    }
  }
  @media (max-width: 767px) {
    .message-item {
      padding-left: 10px;
      padding-right: 10px;
    }
    .message-item[data-layout='list'] {
      gap: 10px;
    }
  }
</style>
