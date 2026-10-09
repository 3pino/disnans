<script lang="ts">
  import MessagesSquare from '@lucide/svelte/icons/messages-square';
  import Avatar from './Avatar.svelte';
  import { threads } from '../lib/stores/threads.svelte';
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

<div class="threads">
  <ul>
    {#each threads.list as t (t.root.id)}
      {@const active = ui.panel?.kind === 'thread' && ui.panel.id === t.root.id}
      {@const unread = threads.unread[t.root.id] ?? 0}
      <li>
        <button type="button" class="item" class:active class:unread={unread > 0} onclick={() => ui.openThread(t.root.id)}>
          <Avatar user={client.user(t.root.author_id)} id={t.root.author_id} size={28} />
          <div class="text">
            <div class="top">
              <span class="name">{client.nameOf(t.root.author_id)}</span>
              <span class="time">{relative(t.info.last_reply_at ?? t.root.created_at, ui.now)}</span>
            </div>
            <div class="preview">{preview(t.root.body, t.root.attachments.length)}</div>
            <div class="meta">
              <MessagesSquare size={12} />
              {t.info.reply_count}
              {#if unread > 0}<span class="badge">{unread}</span>{/if}
            </div>
          </div>
        </button>
      </li>
    {:else}
      <li class="empty muted">
        {#if !threads.loaded}読み込み中…{:else}まだスレッドはありません。メッセージの「スレッドで返信」から始められます{/if}
      </li>
    {/each}
  </ul>
</div>

<style>
  .threads {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0 8px;
  }
  .item {
    display: flex;
    gap: 10px;
    width: 100%;
    padding: 8px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    text-align: left;
  }
  .item:hover {
    background: var(--hover);
  }
  .item.active {
    background: var(--accent-soft);
  }
  .text {
    flex: 1;
    min-width: 0;
  }
  .top {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
  }
  .name {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .time {
    margin-left: auto;
    color: var(--text-muted);
    font-size: 11px;
    flex: none;
  }
  .preview {
    font-size: 13px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .item.unread .preview {
    color: var(--text);
    font-weight: 600;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-top: 2px;
    color: var(--text-muted);
    font-size: 11px;
  }
  .meta .badge {
    margin-left: auto;
  }
  .empty {
    padding: 12px 8px;
    font-size: 13px;
  }
</style>
