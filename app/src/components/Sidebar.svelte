<script lang="ts">
  import AppIcon from './AppIcon.svelte';
  import NavBar from './NavBar.svelte';
  import ThreadList from './ThreadList.svelte';

  // showMain=false はモバイルのスレッド画面。ロゴやナビゲーションは出さない（画面の下に出ている）
  let { showMain = true }: { showMain?: boolean } = $props();
</script>

<aside id="sidebar" class="sidebar">
  {#if showMain}
    <div class="sidebar-brand">
      <span class="sidebar-brand-logo"><AppIcon size={22} /></span>
      <span class="sidebar-brand-name">disnans</span>
    </div>
  {:else}
    <header class="top-bar"></header>
  {/if}

  <div class="scroll sidebar-body">
    <h2 class="sidebar-section-title">スレッド</h2>
    <ThreadList />
  </div>

  {#if showMain}
    <NavBar withThreads={false} />
  {/if}
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
  .sidebar-brand {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 52px;
    padding: 0 18px;
    flex: none;
  }
  .sidebar-brand-logo {
    color: var(--accent);
    display: inline-flex;
  }
  .sidebar-brand .sidebar-brand-name {
    font-weight: 750;
    font-size: 17px;
    letter-spacing: 0.01em;
  }
  .sidebar-body {
    flex: 1;
    min-height: 0;
    padding-bottom: 12px;
  }
  .sidebar-section-title {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 8px 20px 8px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
</style>
