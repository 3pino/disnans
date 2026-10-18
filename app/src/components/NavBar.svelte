<script lang="ts">
  import Settings from '@lucide/svelte/icons/settings';
  import Puzzle from '@lucide/svelte/icons/puzzle';
  import UiNavBar, { type NavBarItem } from './ui/NavBar.svelte';
  import { commandList, findCommand } from '../lib/commands.svelte';
  import { commandHost } from '../lib/commandHost.svelte';
  import { NAV_BUILTIN_IDS, NAV_CALL_ID, NAV_CHAT_ID, NAV_SETTINGS_ID, navItemLabel, visibleNavItems } from '../lib/navBar';
  import { navBar } from '../lib/stores/navBar.svelte';
  import { unread } from '../lib/stores/unread.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { updater } from '../lib/stores/updater.svelte';
  import { showUpdateBadge, UPDATE_BADGE_LABEL } from '../lib/updateCheck';

  // 狭い画面（Android など）では画面の下に横に並べ、広い画面では左に縦に並べる（向きは .nav-bar-side。見た目は ui/NavBar）。
  // 並びと出す項目はデバイスごとの設定（lib/stores/navBar.svelte.ts）。チャット・設定は本体の項目で、
  // ほかのコマンド（プラグインなど）は押すとそのコマンドを実行する。
  // 選んでいる項目は、いま見せている画面（タブ）に合わせる

  // 選んでいる項目（Chat・設定・通話のどれか）
  const current = $derived(ui.tab === 'settings' ? NAV_SETTINGS_ID : ui.tab === 'call' ? NAV_CALL_ID : NAV_CHAT_ID);

  /** 登録されている（出せる）コマンドの ID */
  const available = $derived(new Set(commandList().map((c) => c.id)));
  const ids = $derived(visibleNavItems(navBar.items, available));

  /** 項目の見た目。表示名は設定どおり（lib/navBar.ts の navItemLabel）。本体の3つは専用のアイコンとバッジ、ほかはコマンドのアイコン */
  function toItem(id: string): NavBarItem | null {
    const c = findCommand(id);
    if (!c && !NAV_BUILTIN_IDS.includes(id)) return null;
    const label = navItemLabel(id, c?.name, navBar.labels);
    if (id === NAV_CHAT_ID) {
      // Chat はアプリのロゴ（disnans-logo）
      return { id, label, icon: 'disnans-logo', badge: unread.count };
    }
    // 設定には、新しい版があるときに点を出す
    if (id === NAV_SETTINGS_ID) return { id, label, icon: Settings, alert: showUpdateBadge(updater.state) ? UPDATE_BADGE_LABEL : null };
    return { id, label, icon: c?.icon ?? Puzzle };
  }

  const items = $derived(ids.map(toItem).filter((x): x is NavBarItem => x !== null));

  function select(id: string) {
    // タブの切り替えは遷移の履歴を捨てる（チャット以外のタブで戻ると、チャットのトップへ）
    if (id === NAV_CHAT_ID) {
      ui.selectTab('chat', true);
    } else if (id === NAV_SETTINGS_ID) {
      ui.openSettings();
    } else if (id === NAV_CALL_ID) {
      ui.openCall('reset');
    } else {
      const c = findCommand(id);
      if (c) void commandHost.run(c, 'palette');
    }
  }
</script>

<UiNavBar
  id="nav-bar"
  class="app-nav-bar {ui.isMobile ? '' : 'nav-bar-side'}"
  label="ナビゲーション"
  {items}
  selected={current}
  onselect={select}
/>

<style>
  /* 画面の下に出すので、ナビゲーションバー（Android の edge-to-edge など）の分を空ける（左に出すときは要らない） */
  :global(.nav-bar.app-nav-bar:not(.nav-bar-side)) {
    padding-bottom: env(safe-area-inset-bottom);
  }
</style>
