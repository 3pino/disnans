<script lang="ts">
  import Hash from '@lucide/svelte/icons/hash';
  import MessageCircle from '@lucide/svelte/icons/message-circle';
  import MessagesSquare from '@lucide/svelte/icons/messages-square';
  import Settings from '@lucide/svelte/icons/settings';
  import Sidebar from './Sidebar.svelte';
  import ChatView from './ChatView.svelte';
  import ThreadPanel from './ThreadPanel.svelte';
  import SettingsView from './SettingsView.svelte';
  import Avatar from './Avatar.svelte';
  import ConnectionBanner from './ConnectionBanner.svelte';
  import { client } from '../lib/stores/client.svelte';
  import { threads } from '../lib/stores/threads.svelte';
  import { ui } from '../lib/stores/ui.svelte';

  const panelOpen = $derived(ui.panel !== null);
  const showChat = $derived(ui.isMobile ? ui.tab === 'chat' : ui.tab !== 'settings');
</script>

{#snippet mainEmpty()}
  <div class="empty">
    <p class="big">ようこそ 👋</p>
    <p class="muted">最初のメッセージを送ってみましょう。</p>
  </div>
{/snippet}

<div class="shell" class:mobile={ui.isMobile} class:with-panel={panelOpen} data-tab={ui.tab}>
  {#if !ui.isMobile}
    <div class="side"><Sidebar /></div>
  {/if}

  <main class="main" class:hidden={!showChat}>
    <header class="bar">
      {#if ui.isMobile}
        <span class="title"><Hash size={18} />チャット</span>
        <button type="button" class="me-btn" aria-label="設定" onclick={() => ui.openSettings()}>
          {#if client.me}<Avatar user={client.me} id={client.me.id} size={30} />{/if}
        </button>
      {:else}
        <span class="title"><Hash size={18} />チャット</span>
        <span class="muted desc">みんなの会話</span>
      {/if}
    </header>
    <ConnectionBanner />
    <ChatView threadId={null} placeholder="メッセージを送信" empty={mainEmpty} />
  </main>

  {#if ui.tab === 'settings'}
    <div class="settings-view"><SettingsView /></div>
  {/if}

  {#if ui.isMobile && ui.tab === 'threads'}
    <div class="mobile-threads"><Sidebar showMain={false} /></div>
  {/if}

  {#if ui.panel?.kind === 'thread'}
    <div class="panel">
      <ThreadPanel threadId={ui.panel.id} />
    </div>
  {/if}

  {#if ui.isMobile && !panelOpen}
    <nav class="bottom-nav" aria-label="ナビゲーション">
      <button type="button" class:sel={ui.tab === 'chat'} onclick={() => (ui.tab = 'chat')}>
        <MessageCircle size={22} />
        <span>Chat</span>
      </button>
      <button type="button" class:sel={ui.tab === 'threads'} onclick={() => (ui.tab = 'threads')}>
        <span class="ico">
          <MessagesSquare size={22} />
          {#if threads.totalUnread > 0}<span class="badge">{threads.totalUnread}</span>{/if}
        </span>
        <span>Threads</span>
      </button>
      <button type="button" class:sel={ui.tab === 'settings'} onclick={() => (ui.tab = 'settings')}>
        <Settings size={22} />
        <span>Settings</span>
      </button>
    </nav>
  {/if}
</div>

<style>
  .shell {
    display: grid;
    grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
    height: 100%;
  }
  .shell.with-panel:not(.mobile) {
    grid-template-columns: var(--sidebar-w) minmax(320px, 1fr) minmax(320px, var(--panel-w));
  }
  .side {
    min-height: 0;
  }
  .settings-view {
    min-width: 0;
    min-height: 0;
  }
  .main {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 52px;
    padding: 0 18px;
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 700;
  }
  .title :global(svg) {
    color: var(--text-muted);
  }
  .desc {
    font-size: 13px;
  }
  .panel {
    min-width: 0;
    min-height: 0;
    border-left: 1px solid var(--border);
  }
  .empty {
    margin: auto;
    padding: 40px 16px;
    text-align: center;
  }
  .empty p {
    margin: 4px;
  }
  .big {
    font-size: 20px;
    font-weight: 700;
  }

  /* モバイル */
  .shell.mobile {
    display: flex;
    flex-direction: column;
  }
  .mobile .main,
  .mobile .settings-view,
  .mobile-threads {
    flex: 1;
    min-height: 0;
  }
  .main.hidden {
    display: none;
  }
  .mobile .bar {
    padding: env(safe-area-inset-top) 10px 0 14px;
    height: calc(52px + env(safe-area-inset-top));
  }
  .mobile .title {
    flex: 1;
  }
  .me-btn {
    padding: 0;
    border: none;
    background: none;
    border-radius: 50%;
  }
  .mobile .panel {
    position: fixed;
    inset: 0;
    z-index: 30;
    border: none;
    animation: slide 0.18s ease-out;
  }
  .mobile-threads :global(.sidebar) {
    border-right: none;
  }
  .bottom-nav {
    display: flex;
    flex: none;
    border-top: 1px solid var(--border);
    background: var(--surface);
    padding-bottom: env(safe-area-inset-bottom);
  }
  .bottom-nav button {
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
  .bottom-nav button.sel {
    color: var(--accent);
  }
  .ico {
    position: relative;
    display: inline-flex;
  }
  .ico .badge {
    position: absolute;
    top: -5px;
    left: 14px;
  }
  /* モバイルのスレッド画面ではボトムナビの上にプロフィール欄が来るので、safe-area は不要 */
  .mobile-threads :global(.me) {
    padding-bottom: 10px;
  }
  @keyframes slide {
    from {
      transform: translateX(30%);
      opacity: 0;
    }
  }
</style>
