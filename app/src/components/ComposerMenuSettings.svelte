<script lang="ts">
  import Plus from '@lucide/svelte/icons/plus';
  import X from '@lucide/svelte/icons/x';
  import Puzzle from '@lucide/svelte/icons/puzzle';
  import Button from './ui/Button.svelte';
  import IconButton from './ui/IconButton.svelte';
  import Menu from './ui/Menu.svelte';
  import MenuItem from './ui/MenuItem.svelte';
  import Section from './ui/Section.svelte';
  import SettingRow from './ui/SettingRow.svelte';
  import SortableList from './ui/SortableList.svelte';
  import Toggle from './ui/Toggle.svelte';
  import {
    addComposerMenuCommand,
    composerMenuAvailable,
    composerMenuItems,
    removeComposerMenuEntry,
    reorderComposerMenuEntry,
    setComposerMenuHidden,
  } from '../lib/composerMenu';
  import { prefs } from '../lib/stores/prefs.svelte';

  // 設定の「＋メニュー」: 入力欄の「＋」を押したときに出す項目を、並べ替え・表示の切り替え・コマンドの追加で決める。
  // 並べ替えは共通の SortableList（左のつまみをドラッグ。つまみにフォーカスして上下キーでも動かせる）。
  // 保存はサーバー（prefs）で、同じユーザーの端末で共有する。削除したプラグインの項目は、出ないだけで設定には残る

  let pickerOpen = $state(false);
  /** 本体・プラグインの操作・コマンド（設定では「出す・出さないにかかわらず全部見せる」） */
  const available = $derived(composerMenuAvailable(() => {}));
  /** 並べている項目（出さないものも含む）。表示の順 */
  const items = $derived(composerMenuItems(available, prefs.composerMenu, { includeHidden: true }));
  /** まだ並べていないコマンド */
  const addable = $derived(available.filter((a) => a.kind === 'command' && !items.some((x) => x.entry.id === a.id)));

  function reorder(id: string, toIndex: number) {
    prefs.setComposerMenu(reorderComposerMenuEntry(prefs.composerMenu, available, id, toIndex));
  }

  function setShown(id: string, shown: boolean) {
    prefs.setComposerMenu(setComposerMenuHidden(prefs.composerMenu, id, !shown));
  }

  function remove(id: string) {
    prefs.setComposerMenu(removeComposerMenuEntry(prefs.composerMenu, id));
  }

  function add(id: string) {
    pickerOpen = false;
    prefs.setComposerMenu(addComposerMenuCommand(prefs.composerMenu, available, id));
  }
</script>

<Section title="＋メニュー" class="composer-menu-settings">
  <p class="muted composer-menu-settings-note">
    入力欄の「＋」を押したときに出す項目です。左のつまみをドラッグして並べ替えられます（つまみにフォーカスして上下キーでも動かせます）。
    出さない項目は右の切り替えで外し、追加したコマンドは × で外します。この設定はほかの端末とも共有されます
  </p>

  <SortableList items={items} getId={(x) => x.entry.id} getLabel={(x) => x.entry.label} onmove={reorder} class="composer-menu-settings-list">
    {#snippet row(x)}
      <SettingRow
        name={x.entry.label}
        description={x.entry.source ?? (x.entry.kind === 'command' ? 'コマンド' : '本体')}
        icon={x.entry.icon ?? Puzzle}
      >
        {#snippet control()}
          {#if x.entry.kind === 'command'}
            <IconButton label="{x.entry.label} をメニューから外す" class="composer-menu-settings-remove" onclick={() => remove(x.entry.id)}>
              <X size={16} />
            </IconButton>
          {:else}
            <Toggle checked={!x.hidden} label="{x.entry.label} を「＋」メニューに出す" onchange={(on) => setShown(x.entry.id, on)} />
          {/if}
        {/snippet}
      </SettingRow>
    {/snippet}
  </SortableList>

  <span class="composer-menu-settings-add">
    <Button icon={Plus} aria-haspopup="menu" aria-expanded={pickerOpen} onclick={() => (pickerOpen = !pickerOpen)}>コマンドを追加</Button>
    {#if pickerOpen}
      <Menu class="composer-menu-settings-picker" label="追加するコマンド" onclose={() => (pickerOpen = false)}>
        {#each addable as c (c.id)}
          <MenuItem class="composer-menu-settings-pick" icon={c.icon ?? Puzzle} onclick={() => add(c.id)}>
            {c.label}{#if c.source}<span class="muted composer-menu-settings-source"> · {c.source}</span>{/if}
          </MenuItem>
        {:else}
          <p class="muted composer-menu-settings-none">追加できるコマンドはありません</p>
        {/each}
      </Menu>
    {/if}
  </span>
</Section>

<style>
  .composer-menu-settings-note {
    margin: 0;
    font-size: 13px;
  }
  .composer-menu-settings-add {
    position: relative;
    display: inline-flex;
    align-self: flex-start;
  }
  .composer-menu-settings-add > :global(.composer-menu-settings-picker) {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    /* 外側を閉じる幕（.menu-backdrop, z-index 29）より前に出す。小さい値にすると幕がメニューを覆い、項目が押せなくなる */
    z-index: 30;
    min-width: 240px;
    max-height: 320px;
    overflow-y: auto;
  }
  .composer-menu-settings-source {
    font-size: 12px;
  }
  .composer-menu-settings-none {
    margin: 0;
    padding: 8px 10px;
    font-size: 13px;
  }
</style>
