<script lang="ts">
  import CornerUpLeft from '@lucide/svelte/icons/corner-up-left';
  import X from '@lucide/svelte/icons/x';
  import AuthorAvatar from './AuthorAvatar.svelte';
  import IconButton from './ui/IconButton.svelte';
  import { client } from '../lib/stores/client.svelte';
  import { reply } from '../lib/stores/reply.svelte';
  import { authorOf } from '../lib/author';
  import { mentionsToText } from '../lib/markdown';
  import { replyPreviewOf } from '../lib/reply';

  // 入力欄の上に出す「返信先のアイコン 本文の冒頭 ×」のバー（名前は出さず、アイコンで相手を示す）
  let { threadId }: { threadId: string | null } = $props();

  const target = $derived(reply.get(threadId));
  const author = $derived(target ? authorOf(target, client.users) : null);
  const text = $derived.by(() => {
    if (!target) return '';
    const p = replyPreviewOf(target);
    return mentionsToText(p.body, (id) => client.nameOf(id)) || (p.has_attachments ? '[添付ファイル]' : target.card ? target.card.title : '');
  });
</script>

{#if target && author}
  <div class="reply-bar">
    <CornerUpLeft size={14} />
    <span class="reply-bar-avatar" title={author.name}>
      <AuthorAvatar {author} user={client.user(target.author_id)} id={target.author_id} size={18} />
    </span>
    <span class="reply-bar-text">{text}</span>
    <IconButton label="返信をやめる" onclick={() => reply.clear(threadId)}><X size={16} /></IconButton>
  </div>
{/if}

<style>
  .reply-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
    padding: 2px 4px 2px 10px;
    border-radius: var(--radius-sm);
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 13px;
  }
  .reply-bar > :global(.icon-btn) {
    width: 28px;
    height: 28px;
    margin-left: auto;
    flex: none;
  }
  .reply-bar-avatar {
    display: inline-flex;
    flex: none;
  }
  .reply-bar-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
