<script lang="ts">
  import { onMount } from 'svelte';
  import Sidebar from './Sidebar.svelte';
  import ChatView from './ChatView.svelte';
  import ThreadPanel from './ThreadPanel.svelte';
  import PluginPanel from './PluginPanel.svelte';
  import TimelinePanel from './TimelinePanel.svelte';
  import SettingsView from './SettingsView.svelte';
  import CallView from './CallView.svelte';
  import PluginSettingsPage from './PluginSettingsPage.svelte';
  import ConnectionBanner from './ConnectionBanner.svelte';
  import NavBar from './NavBar.svelte';
  import TopBarSlot from './TopBarSlot.svelte';
  import CommandPalette from './CommandPalette.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { commandHost } from '../lib/commandHost.svelte';

  const panelOpen = $derived(ui.panel !== null);
  const showChat = $derived(ui.isMobile ? ui.tab === 'chat' : ui.tab !== 'settings' && ui.tab !== 'call');

  // 設定（ホットキーなど）の読み込み・本体のコマンドの登録・ホットキーの受け付けを始める
  onMount(() => commandHost.start());
  // モバイルではパネルがチャットを覆う
  const chatVisible = $derived(showChat && !(ui.isMobile && panelOpen));
</script>

{#snippet mainEmpty()}
  <div class="shell-welcome">
    <p class="shell-welcome-title">ようこそ 👋</p>
    <p class="muted shell-welcome-text">最初のメッセージを送ってみましょう。</p>
  </div>
{/snippet}

<div class="shell-root">
<!-- 画面上部の共通の枠（通話のバー・プラグインのステータス欄）。どのタブでも一番上に出る -->
<TopBarSlot />
<div class="shell" class:shell-mobile={ui.isMobile} class:shell-with-panel={panelOpen} data-tab={ui.tab}>
  {#if !ui.isMobile}
    <div class="shell-sidebar"><Sidebar /></div>
  {/if}

  <main id="main-chat" class="shell-main-chat" class:shell-main-chat-hidden={!showChat}>
    <header class="top-bar"></header>
    <ConnectionBanner />
    <ChatView threadId={null} placeholder="メッセージを送信" empty={mainEmpty} active={chatVisible} />
  </main>

  {#if ui.tab === 'settings'}
    <div class="shell-settings">
      <!-- プラグインの設定画面は一覧の代わりに出す。一覧は隠すだけにして、戻ったときに元の位置へ戻せるようにする -->
      {#if ui.pluginSettings}
        <PluginSettingsPage id={ui.pluginSettings} />
      {/if}
      <div class="shell-settings-list" hidden={!!ui.pluginSettings}><SettingsView /></div>
    </div>
  {/if}

  {#if ui.tab === 'call'}
    <div class="shell-call"><CallView /></div>
  {/if}

  {#if ui.isMobile && ui.tab === 'threads'}
    <div class="shell-mobile-threads"><Sidebar showMain={false} /></div>
  {/if}

  {#if ui.panel?.kind === 'thread'}
    <div class="shell-thread-panel">
      <ThreadPanel threadId={ui.panel.id} />
    </div>
  {:else if ui.panel?.kind === 'timeline'}
    <!-- メッセージの集合（返信のツリー・プラグインのタイムライン）。枠はスレッドのパネルと同じ -->
    <div class="shell-thread-panel">
      {#key ui.panel.id}
        <TimelinePanel id={ui.panel.id} />
      {/key}
    </div>
  {:else if ui.panel?.kind === 'plugin'}
    <!-- プラグインの view。枠はスレッドのパネルと同じ -->
    <div class="shell-thread-panel">
      <PluginPanel plugin={ui.panel.plugin} view={ui.panel.view} sessionId={ui.panel.sessionId} />
    </div>
  {/if}

  {#if ui.isMobile && !panelOpen}
    <NavBar withThreads />
  {/if}
</div>
</div>

{#if commandHost.paletteOpen}
  <CommandPalette onclose={() => (commandHost.paletteOpen = false)} />
{/if}

<style>
  .shell-root {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  /* 上の枠に中身があるときは、その下の各画面のヘッダーはステータスバー分の余白を取らない（枠が取っている） */
  .shell-root:has(:global(.call-bar, .plugin-status-item > :not(:empty))) :global(.top-bar) {
    padding-top: 4px;
  }
  .shell {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
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
  .shell-call {
    min-width: 0;
    min-height: 0;
  }
  .shell-settings-list {
    height: 100%;
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
  .shell-mobile .shell-call,
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
