<script lang="ts">
  import '../lib/icons.svelte';
  import Settings from '@lucide/svelte/icons/settings';
  import Puzzle from '@lucide/svelte/icons/puzzle';
  import UiNavBar, { type NavBarItem } from '@3pino/ui-kit-web/NavBar.svelte';
  import { commandList, findCommand } from '../lib/commands.svelte';
  import { commandHost } from '../lib/commandHost.svelte';
  import { NAV_BUILTIN_IDS, NAV_CALL_ID, NAV_CHAT_ID, NAV_SETTINGS_ID, navActiveId, navItemLabel, visibleNavItems } from '../lib/navBar';
  import { navBar } from '../lib/stores/navBar.svelte';
  import { pluginNav, type PluginNavEntry } from '../lib/pluginNav.svelte';
  import { pluginHost } from '../lib/plugins/host.svelte';
  import { coreFiles } from '../lib/coreFiles.svelte';
  import { CORE_FILES_NAV_ID } from '../lib/plugins/core';
  import { NAV_FILES_ID } from '../lib/navBar';
  import { unread } from '../lib/stores/unread.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { updater } from '../lib/stores/updater.svelte';
  import { showUpdateBadge, UPDATE_BADGE_LABEL } from '../lib/updateCheck';

  // 狭い画面（Android など）では画面の下に横に並べ、広い画面では左に縦に並べる（向きは .nav-bar-side。見た目は ui/NavBar）。
  // 並びと出す項目はデバイスごとの設定（lib/stores/navBar.svelte.ts）。チャット・設定は本体の項目で、
  // ほかのコマンド（プラグインなど）は押すとそのコマンドを実行する。
  // 選んでいる項目は、いま見せている画面（タブ）に合わせる

  // 選んでいる項目（共有フォルダ・チャット・設定・通話のどれか。規則は lib/navBar.ts の navActiveId）
  // プラグインの項目（ui.navItem）: 利用者の並べ替えには入らないが、登録されていれば末尾に自動で出る
  const current = $derived.by(() => {
    if (ui.panel?.kind === 'plugin') {
      const hit = pluginNav.forView(ui.panel.plugin, ui.panel.view);
      if (hit) return hit.id;
    }
    if (ui.panel?.kind === 'files' && coreFiles.active) return CORE_FILES_NAV_ID;
    return navActiveId({ tab: ui.tab, panel: ui.panel?.kind ?? null });
  });

  /** 登録されている（出せる）コマンドの ID */
  // コアの「ファイル」が出ているときは、内蔵の「ファイル」の項目は出さない（ナビの項目はプラグインのものになる）
  const available = $derived(new Set(commandList().filter((c) => !(c.id === NAV_FILES_ID && coreFiles.active)).map((c) => c.id)));
  const ids = $derived.by(() => {
    const shown = visibleNavItems(navBar.items, available);
    return [...shown, ...pluginNav.entries.map((e) => e.id).filter((id) => !shown.includes(id))];
  });

  /** 項目の見た目。表示名は設定どおり（lib/navBar.ts の navItemLabel）。本体の3つは専用のアイコンとバッジ、ほかはコマンドのアイコン */
  function toItem(id: string): NavBarItem | null {
    const p = pluginNav.find(id);
    if (p) return { id, label: p.label, icon: p.icon, badge: p.badge };
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
    } else if (pluginNav.find(id)) {
      const p: PluginNavEntry = pluginNav.find(id)!;
      if (p.view) pluginHost.openViewByType(p.view);
      p.onOpen?.();
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
