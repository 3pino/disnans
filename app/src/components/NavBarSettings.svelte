<script lang="ts">
  import Plus from '@lucide/svelte/icons/plus';
  import X from '@lucide/svelte/icons/x';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import Puzzle from '@lucide/svelte/icons/puzzle';
  import Button from './ui/Button.svelte';
  import TextInput from './ui/TextInput.svelte';
  import IconButton from './ui/IconButton.svelte';
  import Menu from './ui/Menu.svelte';
  import MenuItem from './ui/MenuItem.svelte';
  import Section from './ui/Section.svelte';
  import SettingRow from './ui/SettingRow.svelte';
  import SortableList from './ui/SortableList.svelte';
  import { commandList, type AppCommand } from '../lib/commands.svelte';
  import { addNavItem, DEFAULT_NAV_LABELS, NAV_REQUIRED_IDS, removeNavItem, reorderNavItem } from '../lib/navBar';
  import { navBar } from '../lib/stores/navBar.svelte';

  // 設定の「ナビゲーションバー」: 下（デスクトップではサイドバーの下）に出すコマンドを、並べ替え・追加・削除で決める。
  // 並べ替えは共通の SortableList（左のつまみをドラッグ。つまみにフォーカスして上下キーでも動かせる）。
  // 保存はこの端末だけ（localStorage）。チャットと設定は外せない（設定に戻れるように）
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
  <p class="muted nav-bar-settings-note">
    画面の下に出す項目です。並べ替えや、追加・削除ができます。チャットと設定は外せません。この設定はこの端末だけに保存されます
  </p>

  <SortableList items={shown} getId={(c) => c.id} getLabel={(c) => c.name} onmove={reorder} class="nav-bar-settings-list">
    {#snippet row(c)}
      <SettingRow name={c.name} description={c.source ?? '本体'} icon={c.icon ?? Puzzle}>
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
          {#if !NAV_REQUIRED_IDS.includes(c.id)}
            <IconButton label="ナビゲーションバーから外す" class="nav-bar-settings-remove" onclick={() => remove(c.id)}>
              <X size={16} />
            </IconButton>
          {/if}
        {/snippet}
      </SettingRow>
    {/snippet}
  </SortableList>

  <div class="nav-bar-settings-actions">
    <span class="nav-bar-settings-add">
      <Button icon={Plus} aria-haspopup="menu" aria-expanded={pickerOpen} onclick={() => (pickerOpen = !pickerOpen)}>項目を追加</Button>
      {#if pickerOpen}
        <Menu class="nav-bar-settings-picker" label="追加する項目" onclose={() => (pickerOpen = false)}>
          {#each addable as c (c.id)}
            <MenuItem class="nav-bar-settings-pick" icon={c.icon ?? Puzzle} onclick={() => add(c.id)}>
              {c.name}{#if c.source}<span class="muted nav-bar-settings-source"> · {c.source}</span>{/if}
            </MenuItem>
          {:else}
            <p class="muted nav-bar-settings-none">追加できる項目はありません</p>
          {/each}
        </Menu>
      {/if}
    </span>
    <Button icon={RotateCcw} onclick={() => navBar.resetLabels()}>表示名を既定に戻す</Button>
    <Button icon={RotateCcw} onclick={() => navBar.reset()}>項目を既定に戻す</Button>
  </div>
</Section>

<style>
  .nav-bar-settings-note {
    margin: 0;
    font-size: 13px;
  }
  .nav-bar-settings-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .nav-bar-settings-add {
    position: relative;
    display: inline-flex;
  }
  .nav-bar-settings-add > :global(.nav-bar-settings-picker) {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    /* 外側を閉じる幕（.menu-backdrop, z-index 29）より前に出す。ComposerMenuSettings と同じ */
    z-index: 30;
    min-width: 240px;
    max-height: 320px;
    overflow-y: auto;
  }
  :global(.nav-bar-settings-list .nav-bar-settings-label) {
    width: 9em;
    max-width: 40vw;
    min-width: 0;
  }
  .nav-bar-settings-source {
    font-size: 12px;
  }
  .nav-bar-settings-none {
    margin: 0;
    padding: 8px 10px;
    font-size: 13px;
  }
</style>
