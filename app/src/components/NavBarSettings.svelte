<script lang="ts">
  import Plus from '@lucide/svelte/icons/plus';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import Puzzle from '@lucide/svelte/icons/puzzle';
  import Button from './ui/Button.svelte';
  import TextInput from './ui/TextInput.svelte';
  import Menu from './ui/Menu.svelte';
  import MenuItem from './ui/MenuItem.svelte';
  import Section from './ui/Section.svelte';
  import SettingRow from './ui/SettingRow.svelte';
  import SortableList from './ui/SortableList.svelte';
  import { commandList, type AppCommand } from '../lib/commands.svelte';
  import { addNavItem, DEFAULT_NAV_LABELS, navItemRemovable, removeNavItem, reorderNavItem } from '../lib/navBar';
  import { navBar } from '../lib/stores/navBar.svelte';

  // 設定の「ナビゲーションバー」: 出すコマンドを、並べ替え・追加・削除で決める。
  // 並べ替え・削除は共通の SortableList（行をドラッグ。長押しで編集モード。行にフォーカスして上下キーで動かし、Delete で編集モード）。
  // 保存は同じアカウントのデバイスで共有する（ユーザーごとの設定）。チャットと設定は外せない（設定に戻れるように）
  // 表示名は項目ごとに入力欄で決める（空欄で保存するとコマンド名になる。入力欄を空のままにすると既定の名前）

  let pickerOpen = $state(false);
  /** 登録されているコマンド（本体・プラグインのもの） */
  const available = $derived(commandList());
  const availableIds = $derived(new Set(available.map((c) => c.id)));
  /** 並べている項目（登録されているものだけ。表示の順） */
  const shown = $derived(
    navBar.items.map((id) => available.find((c) => c.id === id)).filter((c): c is AppCommand => c !== undefined),
  );
  /** まだ並べていないコマンド */
  const addable = $derived(available.filter((c) => !navBar.items.includes(c.id)));

  function reorder(id: string, toIndex: number) {
    navBar.set(reorderNavItem(navBar.items, availableIds, id, toIndex));
  }

  function remove(id: string) {
    navBar.set(removeNavItem(navBar.items, id));
  }

  function add(id: string) {
    pickerOpen = false;
    navBar.set(addNavItem(navBar.items, id));
  }

  /** 入力欄の見本（未設定なら既定の短い名前、なければコマンド名。設定済みで空欄ならコマンド名） */
  function labelPlaceholder(c: AppCommand): string {
    return navBar.labels[c.id] === undefined ? (DEFAULT_NAV_LABELS[c.id] ?? c.name) : c.name;
  }
</script>

<Section title="ナビゲーションバー" class="nav-bar-settings">
  <SortableList
    items={shown}
    getId={(c) => c.id}
    getLabel={(c) => c.name}
    onmove={reorder}
    removable={(c) => navItemRemovable(c.id)}
    onremove={remove}
    class="nav-bar-settings-list"
  >
    {#snippet row(c, s)}
      <SettingRow
        name={c.name}
        description={c.source}
        icon={c.icon ?? Puzzle}
        deleting={s.deleting}
        ondelete={s.canRemove ? s.remove : undefined}
        deleteLabel="{c.name} をナビゲーションバーから外す"
      >
        {#snippet control()}
          <TextInput
            class="nav-bar-settings-label"
            aria-label="{c.name}の表示名"
            placeholder={labelPlaceholder(c)}
            value={navBar.labels[c.id] ?? ''}
            spellcheck={false}
            autocomplete="off"
            onchange={(e) => navBar.setLabel(c.id, e.currentTarget.value)}
          />
        {/snippet}
      </SettingRow>
    {/snippet}
  </SortableList>

  <div class="setting-list-actions">
    <span class="setting-list-add">
      <Button icon={Plus} aria-haspopup="menu" aria-expanded={pickerOpen} onclick={() => (pickerOpen = !pickerOpen)}>項目を追加</Button>
      {#if pickerOpen}
        <Menu class="setting-list-picker" label="追加する項目" onclose={() => (pickerOpen = false)}>
          {#each addable as c (c.id)}
            <MenuItem class="nav-bar-settings-pick" icon={c.icon ?? Puzzle} onclick={() => add(c.id)}>
              {c.name}{#if c.source}<span class="muted setting-list-source"> · {c.source}</span>{/if}
            </MenuItem>
          {:else}
            <p class="muted setting-list-none">追加できる項目はありません</p>
          {/each}
        </Menu>
      {/if}
    </span>
    <Button icon={RotateCcw} onclick={() => navBar.resetLabels()}>表示名を既定に戻す</Button>
    <Button icon={RotateCcw} onclick={() => navBar.reset()}>項目を既定に戻す</Button>
  </div>
</Section>

<style>
  :global(.nav-bar-settings-list .nav-bar-settings-label) {
    width: 9em;
    max-width: 40vw;
    min-width: 0;
  }
</style>
