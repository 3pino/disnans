<script lang="ts">
  import Megaphone from '@lucide/svelte/icons/megaphone';
  import MessagesSquare from '@lucide/svelte/icons/messages-square';
  import Avatar from './Avatar.svelte';
  import { threads, type ThreadFilter } from '../lib/stores/threads.svelte';
  import { client } from '../lib/stores/client.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { relative } from '../lib/format';
  import { mentionsToText } from '../lib/markdown';

  const tabs: { id: ThreadFilter; label: string }[] = [
    { id: 'all', label: 'すべて' },
    { id: 'status', label: '近況' },
  ];

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
  <div class="tabs" role="tablist">
    {#each tabs as t (t.id)}
      <button
        type="button"
        role="tab"
        aria-selected={threads.filter === t.id}
        class:sel={threads.filter === t.id}
        onclick={() => (threads.filter = t.id)}>{t.label}</button
      >
    {/each}
  </div>

  <ul>
    {#each threads.visible as t (t.root.id)}
      {@const active = ui.panel?.kind === 'thread' && ui.panel.id === t.root.id}
      {@const unread = threads.unread[t.root.id] ?? 0}
      <li>
        <button type="button" class="item" class:active class:unread={unread > 0} onclick={() => ui.openThread(t.root.id)}>
          <Avatar user={client.user(t.root.author_id)} id={t.root.author_id} size={28} />
          <div class="text">
            <div class="top">
              <span class="name">{client.nameOf(t.root.author_id)}</span>
              {#if t.info.kind === 'status'}<span class="kind"><Megaphone size={11} /></span>{/if}
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
        {#if !threads.loaded}読み込み中…{:else if threads.filter === 'status'}まだ近況はありません{:else}まだスレッドはありません。メッセージの「スレッドで返信」から始められます{/if}
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
  .tabs {
    display: flex;
    gap: 4px;
    padding: 4px;
    margin: 0 12px 8px;
    background: var(--surface-2);
    border-radius: var(--radius-sm);
  }
  .tabs button {
    flex: 1;
    height: 30px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--text-muted);
    font-size: 13px;
    font-weight: 600;
  }
  .tabs button.sel {
    background: var(--bg);
    color: var(--text);
    box-shadow: 0 1px 2px oklch(0.1 0.04 248 / 0.2);
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
  .kind {
    display: inline-flex;
    color: var(--accent);
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
