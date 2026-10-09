<script lang="ts">
  import MessageCircle from '@lucide/svelte/icons/message-circle';
  import MessagesSquare from '@lucide/svelte/icons/messages-square';
  import Settings from '@lucide/svelte/icons/settings';
  import { threads } from '../lib/stores/threads.svelte';
  import { ui } from '../lib/stores/ui.svelte';

  // モバイルでは画面の下、デスクトップではサイドバーの下に出す。
  // デスクトップはスレッド一覧がサイドバーに常に出ているので、Threads のタブは出さない
  let { withThreads }: { withThreads: boolean } = $props();

  // デスクトップではスレッドを開いていてもチャットは見えているので、設定以外は Chat を選択中にする
  const current = $derived(ui.tab === 'settings' ? 'settings' : withThreads ? ui.tab : 'chat');

  function openChat() {
    if (!withThreads) ui.closePanel();
    ui.tab = 'chat';
  }
</script>

<nav id="nav-bar" class="nav-bar" aria-label="ナビゲーション">
  <button type="button" class="nav-tab" class:nav-tab-selected={current === 'chat'} onclick={openChat}>
    <MessageCircle size={22} />
    <span class="nav-tab-label">Chat</span>
  </button>
  {#if withThreads}
    <button
      type="button"
      class="nav-tab"
      class:nav-tab-selected={current === 'threads'}
      onclick={() => (ui.tab = 'threads')}
    >
      <span class="nav-tab-icon">
        <MessagesSquare size={22} />
        {#if threads.totalUnread > 0}<span class="badge nav-tab-unread">{threads.totalUnread}</span>{/if}
      </span>
      <span class="nav-tab-label">Threads</span>
    </button>
  {/if}
  <button
    type="button"
    class="nav-tab"
    class:nav-tab-selected={current === 'settings'}
    onclick={() => ui.openSettings()}
  >
    <Settings size={22} />
    <span class="nav-tab-label">Settings</span>
  </button>
</nav>

<style>
  .nav-bar {
    display: flex;
    flex: none;
    border-top: 1px solid var(--border);
    background: var(--surface);
    padding-bottom: env(safe-area-inset-bottom);
  }
  .nav-tab {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 8px 0 6px;
    border: none;
    background: none;
    color: var(--text-muted);
    font-size: 11px;
    font-weight: 600;
  }
  .nav-tab:hover {
    color: var(--text);
  }
  .nav-tab.nav-tab-selected {
    color: var(--accent);
  }
  .nav-tab-icon {
    position: relative;
    display: inline-flex;
  }
  .nav-tab-unread {
    position: absolute;
    top: -5px;
    left: 14px;
  }
</style>
