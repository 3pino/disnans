<script lang="ts">
  import { onMount } from 'svelte';
  import ChatView from './ChatView.svelte';
  import PluginPanel from './PluginPanel.svelte';
  import TimelinePanel from './TimelinePanel.svelte';
  import SettingsView from './SettingsView.svelte';
  import CallView from './CallView.svelte';
  import FileExplorer from './FileExplorer.svelte';
  import PluginSettingsPage from './PluginSettingsPage.svelte';
  import ConnectionBanner from './ConnectionBanner.svelte';
  import NavBar from './NavBar.svelte';
  import TopBarSlot from './TopBarSlot.svelte';
  import CommandPalette from './CommandPalette.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { commandHost } from '../lib/commandHost.svelte';

  const panelOpen = $derived(ui.panel !== null);
  // チャットは Chat タブのときだけ。設定・通話はその場所を使う（どの幅でも同じ）
  const showChat = $derived(ui.tab === 'chat');

  // 設定（ホットキーなど）の読み込み・本体のコマンドの登録・ホットキーの受け付けを始める
  onMount(() => commandHost.start());
  // モバイルではパネルがチャットを覆う
  const chatVisible = $derived(showChat && !(ui.isMobile && panelOpen));
  // 狭い画面のファイルエクスプローラーは全画面に覆わず、ナビゲーションバーの上に収める（ナビバーを見せたまま）
  const filesDocked = $derived(ui.isMobile && ui.panel?.kind === 'files');
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
  <main id="main-chat" class="shell-main-chat" class:shell-main-chat-hidden={!showChat} class:shell-main-chat-away={filesDocked}>
    <header class="top-bar"></header>
    <ConnectionBanner />
    <ChatView placeholder="メッセージを送信" empty={mainEmpty} active={chatVisible} />
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

  {#if ui.panel?.kind === 'timeline'}
    <!-- メッセージの集合（プラグインのタイムライン）。枠は同じ -->
    <div class="shell-panel">
      {#key ui.panel.id}
        <TimelinePanel id={ui.panel.id} />
      {/key}
    </div>
  {:else if ui.panel?.kind === 'replyTree'}
    <!-- 返信のツリー。表示はメッセージの集合と同じ -->
    <div class="shell-panel">
      {#key ui.panel.messageId}
        <TimelinePanel tree={{ messageId: ui.panel.messageId }} />
      {/key}
    </div>
  {:else if ui.panel?.kind === 'files'}
    <!-- 共有フォルダの閲覧 -->
    <div class="shell-panel" class:shell-panel-docked={filesDocked}>
      <FileExplorer />
    </div>
  {:else if ui.panel?.kind === 'plugin'}
    <!-- プラグインの view。枠は同じ -->
    <div class="shell-panel">
      <PluginPanel plugin={ui.panel.plugin} view={ui.panel.view} sessionId={ui.panel.sessionId} />
    </div>
  {/if}

  <!-- 狭い画面ではパネルが開いている間は出さない（下の横並びが覆われるため）。広い画面では左に縦に出し続ける -->
  {#if !ui.isMobile || !panelOpen || filesDocked}
    <NavBar />
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
    padding-top: var(--space-2);
  }
  .shell {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: var(--nav-side-w) minmax(0, 1fr);
  }
  .shell.shell-with-panel:not(.shell-mobile) {
    grid-template-columns: var(--nav-side-w) minmax(320px, 1fr) minmax(320px, var(--panel-w));
  }
  /* 広い画面では、ナビゲーションバーを左の列に置く（DOM の並びは下の横並びのままにしておき、順だけ変える） */
  .shell:not(.shell-mobile) > :global(.app-nav-bar) {
    order: -1;
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
  .shell-panel {
    min-width: 0;
    min-height: 0;
    border-left: 1px solid var(--border);
  }
  .shell-welcome {
    margin: auto;
    padding: 40px var(--space-7);
    text-align: center;
  }
  .shell-welcome p {
    margin: var(--space-2);
  }
  .shell-welcome-title {
    font-size: var(--fs-xl);
    font-weight: var(--fw-bold);
  }

  /* モバイル */
  .shell.shell-mobile {
    display: flex;
    flex-direction: column;
  }
  .shell-mobile .shell-main-chat,
  .shell-mobile .shell-settings,
  .shell-mobile .shell-call {
    flex: 1;
    min-height: 0;
  }
  .shell-main-chat.shell-main-chat-hidden {
    display: none;
  }
  /* エクスプローラーを下に出すとき、チャットは高さを取らない（表示は残し、戻ったときの位置を保つ） */
  .shell-mobile .shell-main-chat.shell-main-chat-away {
    flex: 0 0 0;
    height: 0;
    overflow: hidden;
  }
  .shell-mobile .shell-panel.shell-panel-docked {
    position: relative;
    inset: auto;
    z-index: auto;
    flex: 1;
    min-height: 0;
    animation: none;
  }
  .shell-mobile .shell-panel {
    position: fixed;
    inset: 0;
    z-index: 30;
    border: none;
    /* 全画面のパネルは、ステータスバー・ノッチの分を、ここでまとめて空ける（中のヘッダーでは足さない） */
    padding-top: env(safe-area-inset-top);
    box-sizing: border-box;
    animation: slide 0.18s ease-out;
  }
  @keyframes slide {
    from {
      transform: translateX(30%);
      opacity: 0;
    }
  }
</style>
