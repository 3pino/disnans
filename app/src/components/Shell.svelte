<script lang="ts">
  import Sidebar from './Sidebar.svelte';
  import ChatView from './ChatView.svelte';
  import ThreadPanel from './ThreadPanel.svelte';
  import SettingsView from './SettingsView.svelte';
  import ConnectionBanner from './ConnectionBanner.svelte';
  import NavBar from './NavBar.svelte';
  import { ui } from '../lib/stores/ui.svelte';

  const panelOpen = $derived(ui.panel !== null);
  const showChat = $derived(ui.isMobile ? ui.tab === 'chat' : ui.tab !== 'settings');
</script>

{#snippet mainEmpty()}
  <div class="shell-welcome">
    <p class="shell-welcome-title">ようこそ 👋</p>
    <p class="muted shell-welcome-text">最初のメッセージを送ってみましょう。</p>
  </div>
{/snippet}

<div class="shell" class:shell-mobile={ui.isMobile} class:shell-with-panel={panelOpen} data-tab={ui.tab}>
  {#if !ui.isMobile}
    <div class="shell-sidebar"><Sidebar /></div>
  {/if}

  <main id="main-chat" class="shell-main-chat" class:shell-main-chat-hidden={!showChat}>
    <header class="top-bar"></header>
    <ConnectionBanner />
    <ChatView threadId={null} placeholder="メッセージを送信" empty={mainEmpty} />
  </main>

  {#if ui.tab === 'settings'}
    <div class="shell-settings"><SettingsView /></div>
  {/if}

  {#if ui.isMobile && ui.tab === 'threads'}
    <div class="shell-mobile-threads"><Sidebar showMain={false} /></div>
  {/if}

  {#if ui.panel?.kind === 'thread'}
    <div class="shell-thread-panel">
      <ThreadPanel threadId={ui.panel.id} />
    </div>
  {/if}

  {#if ui.isMobile && !panelOpen}
    <NavBar withThreads />
  {/if}
</div>

<style>
  .shell {
    display: grid;
    grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
    height: 100%;
  }
  .shell.shell-with-panel:not(.shell-mobile) {
    grid-template-columns: var(--sidebar-w) minmax(320px, 1fr) minmax(320px, var(--panel-w));
  }
  .shell-sidebar {
    min-height: 0;
  }
  .shell-settings {
    min-width: 0;
    min-height: 0;
  }
  .shell-main-chat {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .shell-thread-panel {
    min-width: 0;
    min-height: 0;
    border-left: 1px solid var(--border);
  }
  .shell-welcome {
    margin: auto;
    padding: 40px 16px;
    text-align: center;
  }
  .shell-welcome p {
    margin: 4px;
  }
  .shell-welcome-title {
    font-size: 20px;
    font-weight: 700;
  }

  /* モバイル */
  .shell.shell-mobile {
    display: flex;
    flex-direction: column;
  }
  .shell-mobile .shell-main-chat,
  .shell-mobile .shell-settings,
  .shell-mobile-threads {
    flex: 1;
    min-height: 0;
  }
  .shell-main-chat.shell-main-chat-hidden {
    display: none;
  }
  .shell-mobile .shell-thread-panel {
    position: fixed;
    inset: 0;
    z-index: 30;
    border: none;
    animation: slide 0.18s ease-out;
  }
  .shell-mobile-threads :global(.sidebar) {
    border-right: none;
    background: var(--bg);
  }
  @keyframes slide {
    from {
      transform: translateX(30%);
      opacity: 0;
    }
  }
</style>
