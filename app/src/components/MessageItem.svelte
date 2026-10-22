<script lang="ts">
  import MessagesSquare from '@lucide/svelte/icons/messages-square';
  import Reply from '@lucide/svelte/icons/reply';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import X from '@lucide/svelte/icons/x';
  import { SEND_TEXT } from '../lib/sendOutcome';
  import AuthorAvatar from './AuthorAvatar.svelte';
  import ReplyQuote from './ReplyQuote.svelte';
  import Markdown from './Markdown.svelte';
  import Attachments from './Attachments.svelte';
  import Reactions from './Reactions.svelte';
  import EmojiPicker from './EmojiPicker.svelte';
  import MessageInput from './MessageInput.svelte';
  import ActionSheet from './ActionSheet.svelte';
  import MessageCard from './MessageCard.svelte';
  import Button from './ui/Button.svelte';
  import IconButton from './ui/IconButton.svelte';
  import Icon from './ui/Icon.svelte';
  import type { Message } from '../lib/protocol/Message';
  import type { PendingMessage } from '../lib/stores/timeline.svelte';
  import { client } from '../lib/stores/client.svelte';
  import { authorOf, isOwnMessage } from '../lib/author';
  import { ui } from '../lib/stores/ui.svelte';
  import { reply } from '../lib/stores/reply.svelte';
  import { prefs } from '../lib/stores/prefs.svelte';
  import { enterComboLabel, sendCombos } from '../lib/enterKeys';
  import { formatFull, formatStamp, formatTime } from '../lib/format';
  import { QUICK_REACTIONS } from '../lib/emoji';
  import { mentionIds, treeOfMessage } from '../lib/markdown';
  import { resolveMessageActions, type MessageActionContext } from '../lib/messageActions.svelte';
  import { registerCoreMessageActions, removeMessage } from '../lib/messageActionsCore';
  import { timelinePanels } from '../lib/stores/timelinePanel.svelte';
  import { swipeAxis, swipeOffset, swipeProgress, swipeTriggered, type SwipeAxis } from '../lib/swipe';

  let {
    message,
    grouped = false,
    replied = false,
  }: {
    message: Message | PendingMessage;
    grouped?: boolean;
    /** このメッセージへの返信が一覧にあるか（一覧の中でまとめて判定して渡す） */
    replied?: boolean;
  } = $props();

  /** 吹き出しのときの、他人の発言のアイコンの大きさ（px）。ふだんの半分くらい */
  const AVATAR_PX = 20;
  /** リストのときのアイコンの大きさ（px） */
  const AVATAR_LIST_PX = 28;

  /** 表示の仕方（設定）。吹き出しのときだけ、自分の発言を右に寄せ、時刻を吹き出しの横に出す */
  const layout = $derived(prefs.messageLayout);
  const bubble = $derived(layout === 'bubble');
  const pending = $derived('client_id' in message ? (message as PendingMessage) : null);
  /** 投稿者の表示（ボットなら名前とプラグインのアイコン） */
  const author = $derived(authorOf(message, client.users));
  /** 自分の発言（吹き出しの右側）。ボットの発言は、自分が実行したものでも他人の発言として出す */
  const isMine = $derived(isOwnMessage(message, client.me?.id));
  const mentionsMe = $derived(!!client.me && mentionIds(treeOfMessage(message)).includes(client.me.id));
  const editing = $derived(ui.editing === message.id && !pending && !message.card);
  /** 返信できるか（同じ場所のメッセージに返信する） */
  const canReply = $derived(!pending);
  /** 左へのスワイプで返信できるか（メニューの「返信」と同じ） */
  const canSwipe = $derived(canReply && !editing);

  // メッセージの操作（長押しのメニュー・ホバーのツールバー）。本体の項目もプラグインの項目も、同じ登録簿から並べる
  registerCoreMessageActions();
  const actionCtx = $derived<MessageActionContext>({ message: message as Message });
  const menuActions = $derived(pending ? [] : resolveMessageActions(actionCtx, 'menu'));
  const toolbarActions = $derived(pending ? [] : resolveMessageActions(actionCtx, 'toolbar'));
  /** 本文の末尾（インライン）に「返信あり」のアイコンを出す。本文がなければ（カード・添付だけ）下に単独で出す */
  const repliedShown = $derived(replied && !pending);
  const repliedInline = $derived(repliedShown && !message.card && message.body.length > 0);

  /** 一覧のとき、名前と時刻（ヘッダー）を出しているか。アイコンを押すと出し入れする（既定は隠す）。画面全体で1つだけ（ui.headerMessage） */
  const headerShown = $derived(ui.headerMessage === message.id);
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
    // 出していたものを消して、このメッセージのヘッダーだけを出す（同じものなら消す）
    ui.headerMessage = headerShown ? null : message.id;
  }

  function onGutterKeydown(e: KeyboardEvent) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    toggleHeader();
  }

  /** このメッセージへの返信を始める（入力欄の上に返信先を出す） */
  function startReply() {
    if (canReply) reply.set(message as Message);
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
      void removeMessage(message as Message);
      return;
    }
    client.editMessage(message, body);
    ui.editing = null;
  }

  /** 項目を実行する。例外は握りつぶさずトーストで知らせる */
  async function runAction(a: { label: string; run: (anchor: DOMRect, openPicker: (anchor: DOMRect) => void) => void | Promise<void> }, anchor: DOMRect) {
    try {
      await a.run(anchor, (r) => (picker = r));
    } catch (e) {
      ui.toast(`「${a.label}」に失敗しました: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }

  /** このメッセージを起点にした返信のツリーを、パネルに開く */
  function openReplyTree() {
    timelinePanels.openReplyTree(message);
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
      startReply();
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

<!-- 返信を受けたメッセージの目印。押すと、そのメッセージを起点にした返信のツリーを開く -->
{#snippet repliedButton()}
  <button type="button" class="message-replied" aria-label="返信のツリーを開く" title="返信のツリーを開く" onclick={openReplyTree}
    ><MessagesSquare size={13} /></button
  >
{/snippet}

<!-- 本文の末尾に添えるもの（編集済み・返信あり）。本文の最後の行の右に続けて出る -->
{#snippet bodySuffix()}
  {#if message.edited_at}{@render edited()}{/if}
  {#if repliedInline}{@render repliedButton()}{/if}
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
          {#if message.reply_to}
            <ReplyQuote {message} />
          {/if}
          {#if message.card}
            <!-- プラグインのセッションのカード。吹き出しの代わりに、その下に出す -->
            <MessageCard card={message.card} />
          {:else if message.body}
            <div class="message-bubble" class:message-bubble-mine={bubble && isMine} class:message-bubble-other={bubble && !isMine}>
              <div class="message-body">
                <Markdown body={message.body} markdown={'markdown' in message ? message.markdown : undefined} suffix={message.edited_at || repliedInline ? bodySuffix : undefined} />
              </div>
            </div>
          {/if}
          {#if message.attachments.length > 0}
            <Attachments attachments={message.attachments} />
          {/if}
        {/if}

        {#if pending?.unknown}
          <div class="message-send-failed">
            {SEND_TEXT.unknown}
            <button
              type="button"
              class="message-link-button"
              onclick={() => client.timeline().discardPending(pending.client_id)}><X size={13} />{SEND_TEXT.dismissUnknown}</button
            >
          </div>
        {:else if pending?.failed}
          <div class="message-send-failed">
            {SEND_TEXT.failed}
            <button type="button" class="message-link-button" onclick={() => client.retry(pending.client_id)}
              ><RefreshCw size={13} />{SEND_TEXT.retry}</button
            >
            <button
              type="button"
              class="message-link-button"
              onclick={() => client.timeline().discardPending(pending.client_id)}><X size={13} />{SEND_TEXT.discard}</button
            >
          </div>
        {/if}

        <Reactions {message} onaddclick={(r) => (picker = r)} />
      </div>

      {#if repliedShown && !repliedInline}
        <!-- 本文がないメッセージ（カード・添付だけ）は、本文の横には置けないので横に単独で出す -->
        <span class="message-replied-alone">{@render repliedButton()}</span>
      {/if}

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
        <IconButton class="message-toolbar-emoji" label="{e} でリアクション" onclick={() => client.toggleReaction(message as Message, e)}>{e}</IconButton>
      {/each}
      {#each toolbarActions as a (a.id)}
        <IconButton
          class={a.danger ? 'message-toolbar-delete' : ''}
          label={a.label}
          title={a.label}
          onclick={(e) => runAction(a, e.currentTarget.getBoundingClientRect())}
        >
          <Icon icon={a.icon ?? 'puzzle'} size={17} />
        </IconButton>
      {/each}
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
    items={menuActions.map((a) => ({
      id: a.id,
      label: a.label,
      icon: a.icon ?? 'puzzle',
      danger: a.danger,
      run: () => runAction(a, new DOMRect(window.innerWidth / 2 + 140, window.innerHeight / 3, 0, 0)),
    }))}
  />
{/if}

<style>
  .message-item {
    /* 自分の吹き出しの左に残す幅（時刻を含む）。吹き出しのときだけ使う */
    --mine-gap: 72px;
    position: relative;
    display: flex;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-7) var(--space-2);
    margin-top: var(--space-3);
    /* 横方向の操作（スワイプで返信）は自分で受け、縦のスクロールはそのまま */
    touch-action: pan-y;
  }
  .message-item[data-layout='list'] {
    gap: var(--space-6);
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
  /* 返信の引用から飛んできたとき、少しのあいだ強調する */
  .message-item:global(.message-item-flash) {
    animation: message-flash 1.8s ease-out;
  }
  @keyframes message-flash {
    0%,
    40% {
      background: var(--accent-soft);
    }
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
    padding-top: var(--space-1);
  }
  .message-item[data-layout='list'] .message-gutter {
    width: 28px;
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
    gap: var(--space-4);
    line-height: var(--lh-tight);
    margin-bottom: var(--space-1);
  }
  .message-header .message-time {
    font-size: var(--fs-sm);
  }
  .message-item[data-layout='list'] .message-hover-time {
    font-size: var(--fs-xs);
    line-height: 23px;
  }
  .message-author {
    font-weight: var(--fw-semibold);
    line-height: var(--lh-tight);
    -webkit-user-select: none;
    user-select: none;
  }
  /* 返信を受けたメッセージの目印（スレッドはないとき）。吹き出しでは右、一覧では本文の右端に出す */
  /* 返信を受けたメッセージの目印（押すと返信のツリー）。本文の末尾に続けて出す */
  .message-replied {
    display: inline-grid;
    place-items: center;
    margin-left: var(--space-2);
    padding: var(--space-1);
    border: none;
    border-radius: var(--radius-xs);
    background: none;
    color: var(--text-muted);
    opacity: 0.8;
    line-height: 0;
    vertical-align: -2px;
    cursor: pointer;
    -webkit-user-select: none;
    user-select: none;
  }
  .message-replied:hover {
    opacity: 1;
    color: var(--text);
    background: var(--surface-2);
  }
  /* 本文がないメッセージ用。吹き出しの横の下端 / 一覧では右下 */
  .message-replied-alone {
    flex: none;
    align-self: flex-end;
  }
  .message-item[data-layout='list'] .message-replied-alone {
    display: flex;
    justify-content: flex-end;
    align-self: auto;
    width: 100%;
  }
  /* ボットの発言の印。目立たせず、灰色の小さな札にする */
  .message-bot-badge {
    display: inline-block;
    margin-left: var(--space-3);
    padding: 0 5px;
    border-radius: var(--radius-xs);
    background: var(--surface-2);
    color: var(--text-muted);
    font-size: var(--fs-xs);
    font-weight: var(--fw-semibold);
    line-height: 15px;
    letter-spacing: 0.04em;
    vertical-align: 1px;
  }
  /* 吹き出し: 相手の名前は吹き出しの上に小さく */
  .message-item[data-layout='bubble'] .message-author {
    font-size: var(--fs-xs);
    margin: 0 0 var(--space-1) var(--space-1);
  }
  .message-line {
    display: flex;
    align-items: flex-end;
    gap: var(--space-3);
    min-width: 0;
  }
  .message-item[data-layout='list'] .message-line {
    display: block;
  }
  .message-item[data-layout='bubble'] .message-line time {
    font-size: var(--fs-xs);
    line-height: 1;
    margin-bottom: var(--space-1);
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
    padding: 7px var(--space-6);
    border-radius: var(--radius-xl);
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
    font-size: var(--fs-xs);
    color: var(--text-muted);
    -webkit-user-select: none;
    user-select: none;
  }
  .message-editor {
    display: flex;
    width: 100%;
    margin-top: var(--space-1);
    padding: var(--space-1) var(--space-4);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-hover);
    background: var(--bg);
  }
  .message-edit-hint {
    display: flex;
    gap: var(--space-1);
    align-items: center;
    flex-wrap: wrap;
    margin-top: var(--space-2);
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  .message-edit-hint > :global(.btn) {
    height: 32px;
    margin-right: var(--space-3);
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
    gap: var(--space-3);
    margin-top: var(--space-1);
    color: var(--danger);
    font-size: var(--fs-sm);
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
    padding: var(--space-1);
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
    font-size: var(--fs-lg);
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
      padding-left: var(--space-5);
      padding-right: var(--space-5);
    }
    .message-item[data-layout='list'] {
      gap: var(--space-5);
    }
  }
</style>
