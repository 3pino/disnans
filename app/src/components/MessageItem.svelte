<script lang="ts">
  import SmilePlus from '@lucide/svelte/icons/smile-plus';
  import MessageSquare from '@lucide/svelte/icons/message-square';
  import MessagesSquare from '@lucide/svelte/icons/messages-square';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import X from '@lucide/svelte/icons/x';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Avatar from './Avatar.svelte';
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
  import { ui } from '../lib/stores/ui.svelte';
  import { threads } from '../lib/stores/threads.svelte';
  import { formatFull, formatStamp, formatTime, relative } from '../lib/format';
  import { QUICK_REACTIONS } from '../lib/emoji';
  import { extractMentions } from '../lib/markdown';

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

  const pending = $derived('client_id' in message ? (message as PendingMessage) : null);
  const author = $derived(client.user(message.author_id));
  const isMine = $derived(client.me?.id === message.author_id);
  const mentionsMe = $derived(!!client.me && extractMentions(message.body).includes(client.me.id));
  const editing = $derived(ui.editing === message.id && !pending && !message.card);
  const canThread = $derived(!inThread && !pending && message.thread_id === null);
  const unread = $derived(threads.unread[message.id] ?? 0);
  /** プラグインのカードは本文を編集できない（削除はできる） */
  const canEdit = $derived(isMine && !message.card);

  let picker = $state<DOMRect | null>(null);
  let sheet = $state(false);
  let editor: MessageInput | undefined = $state();
  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let pressFired = false;

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

  $effect(() => {
    if (editing) queueMicrotask(() => editor?.focus());
  });
</script>

{#snippet edited()}
  <span class="message-edited" title={message.edited_at ? formatFull(message.edited_at) : undefined}>（編集済み）</span>
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="message-item"
  class:message-item-grouped={grouped}
  class:message-item-pending={!!pending}
  class:message-item-failed={pending?.failed}
  class:message-item-mentioned={mentionsMe}
  class:message-item-editing={editing}
  data-id={message.id}
  ontouchstart={startPress}
  ontouchend={endPress}
  ontouchmove={cancelPress}
  ontouchcancel={cancelPress}
  oncontextmenu={(e) => {
    if (ui.isMobile && !pending) {
      e.preventDefault();
      sheet = true;
    }
  }}
>
  <div class="message-gutter">
    {#if grouped}
      <time class="message-hover-time" datetime={new Date(message.created_at).toISOString()} title={formatFull(message.created_at)}
        >{formatTime(message.created_at)}</time
      >
    {:else}
      <Avatar user={author} id={message.author_id} />
    {/if}
  </div>

  <div class="message-content">
    {#if !grouped}
      <div class="message-header">
        <span class="message-author">{author?.display_name ?? '不明なユーザー'}</span>
        <time class="message-time" datetime={new Date(message.created_at).toISOString()} title={formatFull(message.created_at)}
          >{formatStamp(message.created_at, ui.now)}</time
        >
      </div>
    {/if}

    {#if editing}
      <div class="message-editor">
        <MessageInput
          bind:this={editor}
          initial={message.body}
          enterSends={!ui.isMobile}
          onsubmit={saveEdit}
          oncancel={() => (ui.editing = null)}
        />
      </div>
      <div class="message-edit-hint">
        {#if ui.isMobile}
          <Button onclick={() => (ui.editing = null)}>キャンセル</Button>
          <Button variant="primary" onclick={saveEdit}>保存</Button>
        {:else}
          Esc で<button type="button" class="message-link-button" onclick={() => (ui.editing = null)}>キャンセル</button>・Enter
          で<button type="button" class="message-link-button" onclick={saveEdit}>保存</button>
        {/if}
      </div>
    {:else}
      {#if message.card}
        <!-- プラグインのセッションのカード。本文の代わりに出す -->
        <MessageCard card={message.card} />
      {:else if message.body}
        <div class="message-body">
          <Markdown body={message.body} suffix={message.edited_at ? edited : undefined} />
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
      {#if canEdit}
        <IconButton label="編集" title="編集" onclick={() => (ui.editing = message.id)}><Pencil size={16} /></IconButton>
      {/if}
      {#if isMine}
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
      ...(canThread
        ? [{ label: message.thread ? 'スレッドを開く' : 'スレッドで返信', icon: MessageSquare, run: () => client.openThreadFrom(message) }]
        : []),
      ...(canEdit ? [{ label: '編集', icon: Pencil, run: () => (ui.editing = message.id) }] : []),
      ...(isMine ? [{ label: '削除', icon: Trash2, danger: true, run: remove }] : []),
    ]}
  />
{/if}

<style>
  .message-item {
    position: relative;
    display: flex;
    gap: 12px;
    padding: 6px 16px 4px;
    margin-top: 6px;
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
  .message-item.message-item-pending .message-content {
    opacity: 0.6;
  }
  .message-item.message-item-failed .message-content {
    opacity: 1;
  }
  .message-gutter {
    width: 36px;
    flex: none;
    display: flex;
    justify-content: center;
  }
  .message-hover-time {
    visibility: hidden;
    font-size: 11px;
    color: var(--text-muted);
    line-height: 23px;
    font-variant-numeric: tabular-nums;
  }
  .message-item:hover .message-hover-time {
    visibility: visible;
  }
  .message-content {
    flex: 1;
    min-width: 0;
  }
  .message-header {
    display: flex;
    align-items: baseline;
    gap: 8px;
    line-height: 1.3;
    margin-bottom: 2px;
  }
  .message-author {
    font-weight: 650;
  }
  .message-header .message-time {
    font-size: 12px;
    color: var(--text-muted);
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
    margin-top: 2px;
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--accent);
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
    margin-top: 6px;
    padding: 4px 10px 4px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--accent);
    font-size: 13px;
  }
  .message-thread-link:hover {
    border-color: var(--accent);
  }
  .message-thread-link .message-thread-link-count {
    font-weight: 600;
  }
  .message-thread-link .muted {
    font-size: 12px;
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
      gap: 10px;
    }
  }
</style>
