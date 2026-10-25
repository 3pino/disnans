<script lang="ts">
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import Info from '@lucide/svelte/icons/info';
  import { baseName } from '../lib/sharedPath';
  import type { SharedEntry } from '../lib/protocol/SharedEntry';
  import IconButton from './ui/IconButton.svelte';
  import Menu from './ui/Menu.svelte';
  import MenuItem from './ui/MenuItem.svelte';
  import FileProperties from './FileProperties.svelte';

  // 共有フォルダの項目の「…」: プロパティだけ。名前の変更は一覧の名前を押して行い、
  // コピー・切り取り・削除は選択（長押し）して上端のバーから行う
  let {
    entry,
    placement = 'overlay',
  }: { entry: SharedEntry; placement?: 'overlay' | 'inline' } = $props();

  const name = $derived(baseName(entry.path));
  let open = $state(false);
  let showProperties = $state(false);

  function openProperties() {
    open = false;
    showProperties = true;
  }
</script>

<span class="shared-entry-actions" class:shared-entry-actions-inline={placement === 'inline'}>
  <IconButton
    class="shared-entry-menu-button"
    label="{name} の操作"
    icon={Ellipsis}
    iconSize={16}
    active={open}
    onclick={() => (open = !open)}
  />
  {#if open}
    <Menu class="shared-entry-menu" label="項目の操作" onclose={() => (open = false)}>
      <MenuItem class="shared-entry-menu-item" icon={Info} onclick={openProperties}>プロパティ</MenuItem>
    </Menu>
  {/if}
</span>

{#if showProperties}
  <FileProperties {entry} onclose={() => (showProperties = false)} />
{/if}

<style>
  .shared-entry-actions {
    position: absolute;
    top: var(--space-2);
    right: var(--space-2);
  }
  .shared-entry-actions-inline {
    position: relative;
    top: auto;
    right: auto;
    display: inline-flex;
    flex: none;
    vertical-align: middle;
  }
  /* z-index は指定しない（.menu の --z-menu。下げると外側の幕に覆われて項目が押せない） */
  .shared-entry-actions > :global(.shared-entry-menu) {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
  }
</style>
