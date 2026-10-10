<script lang="ts">
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import X from '@lucide/svelte/icons/x';
  import MessagesSquare from '@lucide/svelte/icons/messages-square';
  import ChatView from './ChatView.svelte';
  import MessageItem from './MessageItem.svelte';
  import ThreadMeta from './ThreadMeta.svelte';
  import IconButton from './ui/IconButton.svelte';
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
  const replyCount = $derived(root?.thread?.reply_count ?? 0);

  $effect(() => {
    const id = threadId;
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
</script>

<div id="thread-panel" class="thread-panel">
  <header class="thread-panel-header">
    {#if ui.isMobile}
      <!-- モバイルは戻るボタンだけ -->
      <IconButton class="thread-panel-back" label="戻る" onclick={() => ui.closePanel()}><ArrowLeft size={20} /></IconButton>
    {:else}
      <div class="thread-panel-title">
        <MessagesSquare size={16} />
        <span>スレッド</span>
      </div>
      <IconButton class="thread-panel-close" label="閉じる" onclick={() => ui.closePanel()}><X size={18} /></IconButton>
    {/if}
  </header>

  {#if root?.thread}<ThreadMeta {root} />{/if}

  {#if notFound && !root}
    <div class="thread-panel-not-found muted">このスレッドは見つかりませんでした。</div>
  {:else}
    {#key threadId}
      <ChatView {threadId} placeholder="スレッドに返信" active>
        {#snippet header()}
          {#if root}
            <div class="thread-panel-root-message">
              <MessageItem message={root} inThread />
            </div>
            {#if replyCount > 0}
              <div class="thread-panel-reply-divider"><span>{replyCount}件の返信</span></div>
            {/if}
          {/if}
        {/snippet}
      </ChatView>
    {/key}
  {/if}
</div>

<style>
  .thread-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--bg);
  }
  .thread-panel-header {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 52px;
    padding: 0 8px 0 16px;
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .thread-panel-title {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    font-weight: 650;
  }
  .thread-panel-root-message {
    padding-bottom: 6px;
  }
  .thread-panel-reply-divider {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 4px 16px 6px;
    color: var(--text-muted);
    font-size: 12px;
  }
  .thread-panel-reply-divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--border);
  }
  .thread-panel-not-found {
    padding: 32px 16px;
    text-align: center;
  }
  @media (max-width: 767px) {
    .thread-panel-header {
      padding: calc(env(safe-area-inset-top) + 4px) 8px 4px 4px;
      height: auto;
      border-bottom: none;
    }
    .thread-panel-header > :global(.thread-panel-back) {
      width: 40px;
      height: 40px;
    }
  }
</style>
