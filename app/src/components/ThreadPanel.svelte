<script lang="ts">
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import X from '@lucide/svelte/icons/x';
  import Megaphone from '@lucide/svelte/icons/megaphone';
  import MessagesSquare from '@lucide/svelte/icons/messages-square';
  import ChatView from './ChatView.svelte';
  import MessageItem from './MessageItem.svelte';
  import { client } from '../lib/stores/client.svelte';
  import { threads } from '../lib/stores/threads.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { api } from '../lib/api';
  import type { Message } from '../lib/protocol/Message';

  let { threadId }: { threadId: string } = $props();

  let fetched = $state<Message | null>(null);
  let notFound = $state(false);

  // 起点のメッセージ: メインチャットの読み込み済み分 → スレッド一覧 → API の順に探す
  const root = $derived(client.peekTimeline(null)?.find(threadId) ?? threads.get(threadId)?.root ?? fetched);
  const kind = $derived(root?.thread?.kind ?? threads.get(threadId)?.info.kind ?? 'normal');
  const replyCount = $derived(root?.thread?.reply_count ?? 0);

  $effect(() => {
    const id = threadId;
    threads.clearUnread(id);
    if (root || !client.ready) return;
    notFound = false;
    api.thread(id).then(
      (t) => {
        if (id === threadId) fetched = t.root;
      },
      () => {
        if (id === threadId) notFound = true;
      },
    );
  });

  // 開いている間に届いた返信は未読にしない
  $effect(() => {
    if ((threads.unread[threadId] ?? 0) > 0 && document.visibilityState === 'visible') threads.clearUnread(threadId);
  });
</script>

<div class="panel">
  <header>
    {#if ui.isMobile}
      <button type="button" class="icon-btn" aria-label="戻る" onclick={() => ui.closePanel()}><ArrowLeft size={20} /></button>
    {/if}
    <div class="title">
      {#if kind === 'status'}<Megaphone size={16} />{:else}<MessagesSquare size={16} />{/if}
      <span>{kind === 'status' ? '近況' : 'スレッド'}</span>
      {#if root}<span class="muted sub">{client.nameOf(root.author_id)}</span>{/if}
    </div>
    {#if !ui.isMobile}
      <button type="button" class="icon-btn" aria-label="閉じる" onclick={() => ui.closePanel()}><X size={18} /></button>
    {/if}
  </header>

  {#if notFound && !root}
    <div class="gone muted">このスレッドは見つかりませんでした。</div>
  {:else}
    {#key threadId}
      <ChatView {threadId} placeholder="スレッドに返信">
        {#snippet header()}
          {#if root}
            <div class="root">
              <MessageItem message={root} inThread />
            </div>
            <div class="divider">
              <span>{replyCount > 0 ? `${replyCount}件の返信` : 'まだ返信はありません'}</span>
            </div>
          {/if}
        {/snippet}
      </ChatView>
    {/key}
  {/if}
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--bg);
  }
  header {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 52px;
    padding: 0 8px 0 16px;
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .title {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    font-weight: 650;
  }
  .sub {
    font-weight: 400;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .root {
    padding-bottom: 6px;
  }
  .divider {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 4px 16px 6px;
    color: var(--text-muted);
    font-size: 12px;
  }
  .divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--border);
  }
  .gone {
    padding: 32px 16px;
    text-align: center;
  }
  @media (max-width: 767px) {
    header {
      padding-left: 4px;
      padding-top: env(safe-area-inset-top);
      height: calc(52px + env(safe-area-inset-top));
    }
  }
</style>
