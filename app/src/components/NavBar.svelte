<script lang="ts">
  import MessagesSquare from '@lucide/svelte/icons/messages-square';
  import Settings from '@lucide/svelte/icons/settings';
  import UiNavBar, { type NavBarItem } from './ui/NavBar.svelte';
  import { unread } from '../lib/stores/unread.svelte';
  import { ui } from '../lib/stores/ui.svelte';

  // モバイルでは画面の下、デスクトップではサイドバーの下に出す。見た目は ui/NavBar（.nav-bar）。
  // デスクトップはスレッド一覧がサイドバーに常に出ているので、Threads のタブは出さない
  let { withThreads }: { withThreads: boolean } = $props();

  // デスクトップではスレッドを開いていてもチャットは見えているので、設定以外は Chat を選択中にする
  const current = $derived(ui.tab === 'settings' ? 'settings' : withThreads ? ui.tab : 'chat');

  const items = $derived<NavBarItem[]>([
    // Chat はアプリのロゴ（disnans-logo）
    { id: 'chat', label: 'Chat', icon: 'disnans-logo', badge: unread.main },
    ...(withThreads ? [{ id: 'threads', label: 'Threads', icon: MessagesSquare, badge: unread.threadTotal }] : []),
    { id: 'settings', label: 'Settings', icon: Settings },
  ]);

  function select(id: string) {
    if (id === 'chat') {
      if (!withThreads) ui.closePanel();
      ui.tab = 'chat';
    } else if (id === 'threads') {
      ui.tab = 'threads';
    } else {
      ui.openSettings();
    }
  }
</script>

<UiNavBar id="nav-bar" class="app-nav-bar" label="ナビゲーション" {items} selected={current} onselect={select} />

<style>
  /* 画面の下に出すので、ナビゲーションバー（Android の edge-to-edge など）の分を空ける */
  :global(.nav-bar.app-nav-bar) {
    padding-bottom: env(safe-area-inset-bottom);
  }
</style>
