<script lang="ts">
  import Settings from '@lucide/svelte/icons/settings';
  import Hash from '@lucide/svelte/icons/hash';
  import AppIcon from './AppIcon.svelte';
  import Avatar from './Avatar.svelte';
  import ThreadList from './ThreadList.svelte';
  import MemberList from './MemberList.svelte';
  import { client } from '../lib/stores/client.svelte';
  import { ui } from '../lib/stores/ui.svelte';

  let { showMain = true }: { showMain?: boolean } = $props();
</script>

<aside class="sidebar">
  <div class="brand">
    <span class="logo"><AppIcon size={22} /></span>
    <span class="name">disnans</span>
  </div>

  <div class="scroll body">
    {#if showMain}
      <button type="button" class="main-link" class:active={!ui.panel} onclick={() => ui.closePanel()}>
        <Hash size={16} />
        チャット
      </button>
    {/if}

    <h2>スレッド</h2>
    <ThreadList />

    <h2>メンバー <span class="count">{client.userList.length}</span></h2>
    <MemberList />
  </div>

  <button type="button" class="me" onclick={() => (ui.profileOpen = true)} aria-label="プロフィールと設定">
    {#if client.me}
      <Avatar user={client.me} id={client.me.id} size={30} />
      <span class="me-text">
        <span class="me-name">{client.me.display_name}</span>
        <span class="me-status" class:off={client.status !== 'open'}>
          <span class="dot"></span>
          {client.status === 'open' ? 'オンライン' : client.status === 'connecting' ? '接続中…' : '切断'}
        </span>
      </span>
    {/if}
    <Settings size={18} />
  </button>
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
  .count {
    font-weight: 500;
  }
  .me {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0;
    padding: 10px 14px;
    padding-bottom: max(10px, env(safe-area-inset-bottom));
    border: none;
    border-top: 1px solid var(--border);
    background: transparent;
    color: var(--text-muted);
    text-align: left;
    flex: none;
  }
  .me:hover {
    background: var(--hover);
  }
  .me-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    line-height: 1.25;
  }
  .me-name {
    color: var(--text);
    font-weight: 600;
    font-size: 14px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .me-status {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--success);
  }
  .me-status.off .dot {
    background: var(--warning);
  }
</style>
