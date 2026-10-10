<script lang="ts">
  import CornerUpLeft from '@lucide/svelte/icons/corner-up-left';
  import AuthorAvatar from './AuthorAvatar.svelte';
  import type { Message } from '../lib/protocol/Message';
  import { client } from '../lib/stores/client.svelte';
  import { authorOf } from '../lib/author';
  import { jumpToMessage } from '../lib/jump';
  import { mentionsToText } from '../lib/markdown';

  // 返信のメッセージの本文の上に出す、返信先の小さな引用。押すと元のメッセージまでスクロールする。
  // 返信先が削除されていれば、押せない「削除されたメッセージ」にする
  let { message, threadId }: { message: Pick<Message, 'reply_to' | 'reply_preview'>; threadId: string | null } = $props();

  const preview = $derived(message.reply_preview);
  const author = $derived(preview ? authorOf(preview, client.users) : null);
  const text = $derived(
    preview ? mentionsToText(preview.body, (id) => client.nameOf(id)) || (preview.has_attachments ? '[添付ファイル]' : '') : '',
  );

  function open(e: MouseEvent) {
    if (!message.reply_to) return;
    void jumpToMessage(e.currentTarget as HTMLElement, client.timeline(threadId), message.reply_to);
  }
</script>

{#if preview && author}
  <button type="button" class="reply-quote" title="元のメッセージへ移動" onclick={open}>
    <CornerUpLeft size={12} class="reply-quote-mark" />
    <AuthorAvatar {author} user={client.user(preview.author_id)} id={preview.author_id} size={16} />
    <span class="reply-quote-name">{author.name}</span>
    <span class="reply-quote-text">{text}</span>
  </button>
{:else}
  <div class="reply-quote reply-quote-deleted">
    <CornerUpLeft size={12} class="reply-quote-mark" />
    <span class="reply-quote-text">削除されたメッセージ</span>
  </div>
{/if}

<style>
  .reply-quote {
    display: flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    margin-bottom: 2px;
    padding: 0;
    border: none;
    background: none;
    color: var(--text-muted);
    font-size: 12px;
    line-height: 1.4;
    text-align: left;
    cursor: pointer;
  }
  button.reply-quote:hover .reply-quote-text {
    text-decoration: underline;
  }
  .reply-quote.reply-quote-deleted {
    cursor: default;
    font-style: italic;
  }
  .reply-quote :global(.reply-quote-mark) {
    flex: none;
  }
  .reply-quote-name {
    flex: none;
    font-weight: 600;
    color: var(--text);
  }
  .reply-quote-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
