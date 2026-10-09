<script lang="ts">
  import Settings from '@lucide/svelte/icons/settings';
  import Hash from '@lucide/svelte/icons/hash';
  import AppIcon from './AppIcon.svelte';
  import ThreadList from './ThreadList.svelte';
  import { ui } from '../lib/stores/ui.svelte';

  // showMain=false はモバイルのスレッド画面。ロゴや「チャット」「設定」の入口は出さない
  let { showMain = true }: { showMain?: boolean } = $props();
</script>

<aside class="sidebar">
  {#if showMain}
    <div class="brand">
      <span class="logo"><AppIcon size={22} /></span>
      <span class="name">disnans</span>
    </div>
  {:else}
    <header class="top-bar"></header>
  {/if}

  <div class="scroll body">
    {#if showMain}
      <nav class="links" aria-label="ナビゲーション">
        <button
          type="button"
          class="main-link"
          class:active={!ui.panel && ui.tab !== 'settings'}
          onclick={() => {
            ui.closePanel();
            ui.tab = 'chat';
          }}
        >
          <Hash size={16} />
          チャット
        </button>
        <button type="button" class="main-link" class:active={ui.tab === 'settings'} onclick={() => ui.openSettings()}>
          <Settings size={16} />
          設定
        </button>
      </nav>
    {/if}

    <h2>スレッド</h2>
    <ThreadList />
  </div>
</aside>

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--surface);
    border-right: 1px solid var(--border);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 52px;
    padding: 0 18px;
    flex: none;
  }
  .logo {
    color: var(--accent);
    display: inline-flex;
  }
  .brand .name {
    font-weight: 750;
    font-size: 17px;
    letter-spacing: 0.01em;
  }
  .body {
    flex: 1;
    min-height: 0;
    padding-bottom: 12px;
  }
  .links {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .main-link {
    display: flex;
    align-items: center;
    gap: 8px;
    width: calc(100% - 16px);
    margin: 0 8px;
    padding: 8px 10px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    font-weight: 600;
    text-align: left;
  }
  .main-link:hover {
    background: var(--hover);
  }
  .main-link.active {
    background: var(--accent-soft);
    color: var(--accent);
  }
  h2 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 18px 20px 8px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
</style>
