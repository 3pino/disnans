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
  const editing = $derived(ui.editing === message.id && !pending);
  const canThread = $derived(!inThread && !pending && message.thread_id === null);
  const unread = $derived(threads.unread[message.id] ?? 0);

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
  <span class="edited" title={message.edited_at ? formatFull(message.edited_at) : undefined}>（編集済み）</span>
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="msg"
  class:grouped
  class:pending={!!pending}
  class:failed={pending?.failed}
  class:mentioned={mentionsMe}
  class:editing
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
  <div class="gutter">
    {#if grouped}
      <time class="hover-time" datetime={new Date(message.created_at).toISOString()} title={formatFull(message.created_at)}
        >{formatTime(message.created_at)}</time
      >
    {:else}
      <Avatar user={author} id={message.author_id} />
    {/if}
  </div>

  <div class="content">
    {#if !grouped}
      <div class="head">
        <span class="author">{author?.display_name ?? '不明なユーザー'}</span>
        <time datetime={new Date(message.created_at).toISOString()} title={formatFull(message.created_at)}
          >{formatStamp(message.created_at, ui.now)}</time
        >
      </div>
    {/if}

    {#if editing}
      <div class="editor">
        <MessageInput
          bind:this={editor}
          initial={message.body}
          enterSends={!ui.isMobile}
          onsubmit={saveEdit}
          oncancel={() => (ui.editing = null)}
        />
      </div>
      <div class="edit-hint">
        {#if ui.isMobile}
          <button type="button" class="btn" onclick={() => (ui.editing = null)}>キャンセル</button>
          <button type="button" class="btn primary" onclick={saveEdit}>保存</button>
        {:else}
          Esc で<button type="button" class="link" onclick={() => (ui.editing = null)}>キャンセル</button>・Enter
          で<button type="button" class="link" onclick={saveEdit}>保存</button>
        {/if}
      </div>
    {:else}
      {#if message.body}
        <div class="body">
          <Markdown body={message.body} suffix={message.edited_at ? edited : undefined} />
        </div>
      {/if}
      {#if message.attachments.length > 0}
        <Attachments attachments={message.attachments} />
      {/if}
      <!-- 将来: プラグインのカード（message.card）はここに描画する -->
    {/if}

    {#if pending?.failed}
      <div class="fail">
        送信できませんでした
        <button type="button" class="link" onclick={() => client.retry(message.thread_id, pending.client_id)}
          ><RefreshCw size={13} />再送</button
        >
        <button
          type="button"
          class="link"
          onclick={() => client.timeline(message.thread_id).discardPending(pending.client_id)}><X size={13} />取り消す</button
        >
      </div>
    {/if}

    <Reactions {message} onaddclick={(r) => (picker = r)} />

    {#if message.thread && !inThread}
      <button type="button" class="thread-link" onclick={() => ui.openThread(message.id)}>
        <MessagesSquare size={15} />
        {#if message.thread.reply_count > 0}
          <span class="count">{message.thread.reply_count}件の返信</span>
          {#if message.thread.last_reply_at}
            <span class="muted">最終 {relative(message.thread.last_reply_at, ui.now)}</span>
          {/if}
        {:else}
          <span class="count">スレッドで返信</span>
        {/if}
        {#if unread > 0}<span class="badge">{unread}</span>{/if}
        <ChevronRight size={14} />
      </button>
    {/if}
  </div>

  {#if !pending && !editing}
    <div class="toolbar" role="toolbar" aria-label="メッセージの操作">
      {#each QUICK_REACTIONS.slice(0, 3) as e (e)}
        <button type="button" class="icon-btn emoji" aria-label="{e} でリアクション" onclick={() => client.toggleReaction(message, e)}
          >{e}</button
        >
      {/each}
      <button
        type="button"
        class="icon-btn"
        aria-label="リアクション"
        title="リアクション"
        onclick={(e) => (picker = e.currentTarget.getBoundingClientRect())}><SmilePlus size={17} /></button
      >
      {#if canThread}
        <button
          type="button"
          class="icon-btn"
          aria-label={message.thread ? 'スレッドを開く' : 'スレッドを作る'}
          title={message.thread ? 'スレッドを開く' : 'スレッドで返信'}
          onclick={() => client.openThreadFrom(message)}><MessageSquare size={17} /></button
        >
      {/if}
      {#if isMine}
        <button type="button" class="icon-btn" aria-label="編集" title="編集" onclick={() => (ui.editing = message.id)}
          ><Pencil size={16} /></button
        >
        <button type="button" class="icon-btn danger" aria-label="削除" title="削除" onclick={remove}
          ><Trash2 size={16} /></button
        >
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
      ...(isMine
        ? [
            { label: '編集', icon: Pencil, run: () => (ui.editing = message.id) },
            { label: '削除', icon: Trash2, danger: true, run: remove },
          ]
        : []),
    ]}
  />
{/if}

<style>
  .msg {
    position: relative;
    display: flex;
    gap: 12px;
    padding: 6px 16px 4px;
    margin-top: 6px;
  }
  .msg.grouped {
    margin-top: 0;
    padding-top: 1px;
  }
  .msg:hover {
    background: color-mix(in oklch, var(--surface) 55%, transparent);
  }
  .msg.mentioned {
    background: var(--mention-soft);
    box-shadow: inset 2px 0 0 var(--mention);
  }
  .msg.editing {
    background: var(--accent-soft);
  }
  .msg.pending .content {
    opacity: 0.6;
  }
  .msg.failed .content {
    opacity: 1;
  }
  .gutter {
    width: 36px;
    flex: none;
    display: flex;
    justify-content: center;
  }
  .hover-time {
    visibility: hidden;
    font-size: 11px;
    color: var(--text-muted);
    line-height: 23px;
    font-variant-numeric: tabular-nums;
  }
  .msg:hover .hover-time {
    visibility: visible;
  }
  .content {
    flex: 1;
    min-width: 0;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    line-height: 1.3;
    margin-bottom: 2px;
  }
  .author {
    font-weight: 650;
  }
  .head time {
    font-size: 12px;
    color: var(--text-muted);
  }
  .body {
    min-width: 0;
  }
  .edited {
    font-size: 11px;
    color: var(--text-muted);
  }
  .editor {
    display: flex;
    margin-top: 2px;
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--accent);
    background: var(--bg);
  }
  .edit-hint {
    display: flex;
    gap: 2px;
    align-items: center;
    flex-wrap: wrap;
    margin-top: 4px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .edit-hint .btn {
    height: 32px;
    margin-right: 6px;
  }
  .link {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 0 3px;
    border: none;
    background: none;
    color: var(--accent);
    font-size: inherit;
  }
  .link:hover {
    text-decoration: underline;
  }
  .fail {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 2px;
    color: var(--danger);
    font-size: 12px;
  }
  .thread-link {
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
  .thread-link:hover {
    border-color: var(--accent);
  }
  .thread-link .count {
    font-weight: 600;
  }
  .thread-link .muted {
    font-size: 12px;
  }
  .toolbar {
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
  .toolbar .icon-btn {
    width: 30px;
    height: 30px;
  }
  .toolbar .emoji {
    font-size: 16px;
  }
  .toolbar .danger:hover {
    color: var(--danger);
    background: var(--danger-soft);
  }
  .msg:hover .toolbar,
  .msg:focus-within .toolbar {
    display: flex;
  }
  @media (hover: none) {
    .msg:hover .toolbar,
    .msg:focus-within .toolbar {
      display: none;
    }
    .msg:hover {
      background: none;
    }
    .msg {
      -webkit-touch-callout: none;
    }
  }
  @media (max-width: 767px) {
    .msg {
      padding-left: 10px;
      padding-right: 10px;
      gap: 10px;
    }
  }
</style>
