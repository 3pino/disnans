<script lang="ts">
  import MessagesSquare from '@lucide/svelte/icons/messages-square';
  import Paperclip from '@lucide/svelte/icons/paperclip';
  import Archive from '@lucide/svelte/icons/archive';
  import AuthorAvatar from './AuthorAvatar.svelte';
  import MessageCard from './MessageCard.svelte';
  import TagChip from './TagChip.svelte';
  import type { Thread } from '../lib/protocol/Thread';
  import { unread as unreadStore } from '../lib/stores/unread.svelte';
  import { client } from '../lib/stores/client.svelte';
  import { authorOf } from '../lib/author';
  import { ui } from '../lib/stores/ui.svelte';
  import { relative } from '../lib/format';
  import { mentionsToText } from '../lib/markdown';
  import { fileUrl } from '../lib/config';
  import { threadTitle } from '../lib/thread';

  let { thread: t }: { thread: Thread } = $props();

  /** アイコンの大きさ（px）。チャットのアイコン（MessageItem の AVATAR_LIST_PX）と同じ */
  const AVATAR_PX = 28;

  const active = $derived(ui.panel?.kind === 'thread' && ui.panel.id === t.root.id);
  const unread = $derived(unreadStore.count(t.root.id));
  const author = $derived(authorOf(t.root, client.users));
  const title = $derived(threadTitle(t));
  /** アイコンを押すと、作った人の名前を出す（チャットのリスト表示と同じ） */
  let nameShown = $state(false);

  const text = $derived(
    mentionsToText(t.root.body, (id) => client.nameOf(id))
      .replace(/```[\s\S]*?(```|$)/g, '[コード]')
      .replace(/[*_>`]/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  );
  const attachments = $derived(t.root.attachments);
  /** 先頭の添付が画像なら、そのサムネイルを出す */
  const image = $derived(attachments.find((a) => a.mime.startsWith('image/')) ?? null);
</script>

<div class="thread-item" class:thread-item-archived={t.info.archived} class:thread-item-active={active}>
  <button
    type="button"
    class="thread-item-avatar"
    aria-pressed={nameShown}
    aria-label={nameShown ? '名前を隠す' : '名前を表示'}
    onclick={() => (nameShown = !nameShown)}
  >
    <AuthorAvatar {author} user={client.user(t.root.author_id)} id={t.root.author_id} size={AVATAR_PX} />
  </button>

  <button
    type="button"
    class="thread-item-main"
    class:thread-item-unread={unread > 0}
    onclick={() => ui.openThread(t.root.id)}
  >
    <span class="thread-item-header">
      {#if nameShown}
        <span class="thread-item-author">{author.name}</span>
        {#if author.isBot}<span class="thread-item-bot-badge">BOT</span>{/if}
      {/if}
      {#if t.info.archived}<span class="thread-item-archived-mark"><Archive size={12} />アーカイブ</span>{/if}
      <span class="thread-item-time">{relative(t.info.last_reply_at ?? t.root.created_at, ui.now)}</span>
    </span>

    {#if title}<span class="thread-item-title">{title}</span>{/if}
    {#if text}
      <span class="thread-item-preview" class:thread-item-preview-sub={!!title}>{text}</span>
    {/if}

    {#if t.root.card}
      <!-- カードは見せるだけ（押したときはスレッドを開く） -->
      <span class="thread-item-card" inert><MessageCard card={t.root.card} /></span>
    {:else if image}
      <img class="thread-item-thumb" src={fileUrl(image.id, image.has_thumb)} alt={image.file_name} loading="lazy" decoding="async" />
    {:else if !text && attachments.length > 0}
      <span class="thread-item-files"><Paperclip size={13} />ファイル {attachments.length}件</span>
    {/if}

    {#if t.info.tags.length > 0}
      <span class="thread-item-tags">
        {#each t.info.tags as tag (tag.label + '/' + (tag.icon ?? ''))}<TagChip {tag} />{/each}
      </span>
    {/if}

    <span class="thread-item-meta">
      <MessagesSquare size={12} />
      {t.info.reply_count}
      {#if unread > 0}<span class="badge thread-item-unread-count">{unread}</span>{/if}
    </span>
  </button>
</div>

<style>
  .thread-item {
    position: relative;
    display: flex;
    gap: 10px;
    padding: 0 8px 0 0;
    border-radius: var(--radius-sm);
  }
  .thread-item:hover {
    background: var(--hover);
  }
  /* アーカイブ済みは薄く（返信はできる） */
  .thread-item-archived > button {
    opacity: 0.55;
  }
  .thread-item-avatar {
    flex: none;
    align-self: flex-start;
    margin: 8px 0 0 8px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: none;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .thread-item-avatar:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .thread-item-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    padding: 8px 0;
    border: none;
    background: transparent;
    text-align: left;
    color: inherit;
  }
  .thread-item.thread-item-active {
    background: var(--accent-soft);
  }
  .thread-item-header {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 16px;
    font-size: 13px;
  }
  .thread-item-author {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* ボットの発言の印（MessageItem の .message-bot-badge と同じ見た目） */
  .thread-item-bot-badge {
    flex: none;
    padding: 0 5px;
    border-radius: 4px;
    background: var(--surface-2);
    color: var(--text-muted);
    font-size: 10px;
    font-weight: 600;
    line-height: 15px;
    letter-spacing: 0.04em;
  }
  .thread-item-archived-mark {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    color: var(--text-muted);
    font-size: 11px;
  }
  .thread-item-time {
    margin-left: auto;
    color: var(--text-muted);
    font-size: 11px;
    flex: none;
  }
  .thread-item-title {
    font-size: 14px;
    font-weight: 650;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .thread-item-preview {
    font-size: 13px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .thread-item-preview-sub {
    font-size: 12px;
  }
  .thread-item-main.thread-item-unread .thread-item-preview,
  .thread-item-main.thread-item-unread .thread-item-title {
    color: var(--text);
    font-weight: 600;
  }
  .thread-item-thumb {
    display: block;
    align-self: flex-start;
    max-width: 100%;
    max-height: 96px;
    margin-top: 4px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    object-fit: cover;
  }
  .thread-item-files {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--text-muted);
    font-size: 13px;
  }
  .thread-item-card {
    display: block;
    margin-top: 4px;
    font-size: 12px;
    pointer-events: none;
  }
  .thread-item-card :global(.message-card) {
    margin-top: 0;
    padding: 5px 8px;
    max-width: 100%;
  }
  .thread-item-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 4px;
  }
  .thread-item-meta {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-top: 2px;
    color: var(--text-muted);
    font-size: 11px;
  }
  .thread-item-meta .badge {
    margin-left: auto;
  }
</style>
