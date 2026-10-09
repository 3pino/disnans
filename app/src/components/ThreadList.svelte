<script lang="ts">
  import MessagesSquare from '@lucide/svelte/icons/messages-square';
  import Avatar from './Avatar.svelte';
  import { threads } from '../lib/stores/threads.svelte';
  import { unread as unreadStore } from '../lib/stores/unread.svelte';
  import { client } from '../lib/stores/client.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { relative } from '../lib/format';
  import { mentionsToText } from '../lib/markdown';

  function preview(body: string, attachments: number): string {
    const text = mentionsToText(body, (id) => client.nameOf(id))
      .replace(/```[\s\S]*?(```|$)/g, '[コード]')
      .replace(/[*_>`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) return text;
    return attachments > 0 ? `📎 ファイル ${attachments}件` : '';
  }
</script>

<div class="thread-list">
  <ul class="thread-list-items">
    {#each threads.list as t (t.root.id)}
      {@const active = ui.panel?.kind === 'thread' && ui.panel.id === t.root.id}
      {@const unread = unreadStore.count(t.root.id)}
      <li class="thread-list-entry">
        <button type="button" class="thread-list-item" class:thread-list-item-active={active} class:thread-list-item-unread={unread > 0} onclick={() => ui.openThread(t.root.id)}>
          <Avatar user={client.user(t.root.author_id)} id={t.root.author_id} size={28} />
          <div class="thread-list-item-text">
            <div class="thread-list-item-header">
              <span class="thread-list-item-author">{client.nameOf(t.root.author_id)}</span>
              <span class="thread-list-item-time">{relative(t.info.last_reply_at ?? t.root.created_at, ui.now)}</span>
            </div>
            <div class="thread-list-item-preview">{preview(t.root.body, t.root.attachments.length)}</div>
            <div class="thread-list-item-meta">
              <MessagesSquare size={12} />
              {t.info.reply_count}
              {#if unread > 0}<span class="badge thread-list-item-unread-count">{unread}</span>{/if}
            </div>
          </div>
        </button>
      </li>
    {:else}
      <li class="thread-list-empty muted">
        {#if !threads.loaded}読み込み中…{:else}まだスレッドはありません。メッセージの「スレッドで返信」から始められます{/if}
      </li>
    {/each}
  </ul>
</div>

<style>
  .thread-list {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .thread-list-items {
    list-style: none;
    margin: 0;
    padding: 0 8px;
  }
  .thread-list-item {
    display: flex;
    gap: 10px;
    width: 100%;
    padding: 8px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    text-align: left;
  }
  .thread-list-item:hover {
    background: var(--hover);
  }
  .thread-list-item.thread-list-item-active {
    background: var(--accent-soft);
  }
  .thread-list-item-text {
    flex: 1;
    min-width: 0;
  }
  .thread-list-item-header {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
  }
  .thread-list-item-author {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .thread-list-item-time {
    margin-left: auto;
    color: var(--text-muted);
    font-size: 11px;
    flex: none;
  }
  .thread-list-item-preview {
    font-size: 13px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .thread-list-item.thread-list-item-unread .thread-list-item-preview {
    color: var(--text);
    font-weight: 600;
  }
  .thread-list-item-meta {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-top: 2px;
    color: var(--text-muted);
    font-size: 11px;
  }
  .thread-list-item-meta .badge {
    margin-left: auto;
  }
  .thread-list-empty {
    padding: 12px 8px;
    font-size: 13px;
  }
</style>
