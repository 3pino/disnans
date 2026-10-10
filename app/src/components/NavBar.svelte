<script lang="ts">
  import MessagesSquare from '@lucide/svelte/icons/messages-square';
  import Settings from '@lucide/svelte/icons/settings';
  import Puzzle from '@lucide/svelte/icons/puzzle';
  import UiNavBar, { type NavBarItem } from './ui/NavBar.svelte';
  import { commandList, findCommand } from '../lib/commands.svelte';
  import { commandHost } from '../lib/commandHost.svelte';
  import { NAV_BUILTIN_IDS, NAV_CALL_ID, NAV_CHAT_ID, NAV_SETTINGS_ID, NAV_THREADS_ID, navItemLabel, visibleNavItems } from '../lib/navBar';
  import { navBar } from '../lib/stores/navBar.svelte';
  import { unread } from '../lib/stores/unread.svelte';
  import { ui } from '../lib/stores/ui.svelte';

  // モバイルでは画面の下、デスクトップではサイドバーの下に出す。見た目は ui/NavBar（.nav-bar）。
  // 並びと出す項目は端末ごとの設定（lib/stores/navBar.svelte.ts）。チャット・スレッド・設定は本体の項目で、
  // ほかのコマンド（プラグインなど）は押すとそのコマンドを実行する。
  // デスクトップはスレッド一覧がサイドバーに常に出ているので、Threads は withThreads が false のとき出さない
  let { withThreads }: { withThreads: boolean } = $props();

  // 選んでいる項目。デスクトップではスレッドを開いていてもチャットは見えているので、設定以外は Chat を選択中にする
  const current = $derived(ui.tab === 'settings' ? NAV_SETTINGS_ID : ui.tab === 'call' ? NAV_CALL_ID : withThreads && ui.tab === 'threads' ? NAV_THREADS_ID : NAV_CHAT_ID);

  /** 登録されている（出せる）コマンドの ID */
  const available = $derived(new Set(commandList().map((c) => c.id)));
  const ids = $derived(visibleNavItems(navBar.items, available, { withThreads }));

  /** 項目の見た目。表示名は設定どおり（lib/navBar.ts の navItemLabel）。本体の3つは専用のアイコンとバッジ、ほかはコマンドのアイコン */
  function toItem(id: string): NavBarItem | null {
    const c = findCommand(id);
    if (!c && !NAV_BUILTIN_IDS.includes(id)) return null;
    const label = navItemLabel(id, c?.name, navBar.labels);
    if (id === NAV_CHAT_ID) {
      // Chat はアプリのロゴ（disnans-logo）
      return { id, label, icon: 'disnans-logo', badge: unread.main };
    }
    if (id === NAV_THREADS_ID) return { id, label, icon: MessagesSquare, badge: unread.threadTotal };
    if (id === NAV_SETTINGS_ID) return { id, label, icon: Settings };
    return { id, label, icon: c?.icon ?? Puzzle };
  }

  const items = $derived(ids.map(toItem).filter((x): x is NavBarItem => x !== null));

  function select(id: string) {
    if (id === NAV_CHAT_ID) {
      if (!withThreads) ui.closePanel();
      ui.tab = 'chat';
    } else if (id === NAV_THREADS_ID) {
      ui.tab = 'threads';
    } else if (id === NAV_SETTINGS_ID) {
      ui.openSettings();
    } else {
      const c = findCommand(id);
      if (c) void commandHost.run(c, 'palette');
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
