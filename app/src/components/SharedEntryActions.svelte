<script lang="ts">
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Trash from '@lucide/svelte/icons/trash';
  import { attachmentActionText } from '../lib/fileLink';
  import { deleteConfirm, nameError, renameNote, renameTarget } from '../lib/sharedOps';
  import { sharedApi } from '../lib/transport/shared';
  import { sharedIndex } from '../lib/stores/sharedIndex.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { parentOf, baseName } from '../lib/sharedPath';
  import IconButton from './ui/IconButton.svelte';
  import Menu from './ui/Menu.svelte';
  import MenuItem from './ui/MenuItem.svelte';
  import Modal from './ui/Modal.svelte';
  import TextInput from './ui/TextInput.svelte';
  import Button from './ui/Button.svelte';

  // 共有フォルダの項目の操作: 名前の変更・削除。どの人も変えられる（サーバーの決まり）。
  // 添付（本文のリンクの中・添付の一覧）と、共有フォルダの一覧の両方で使う。変わったことは files.changed で全員に届く
  let {
    path,
    dir = false,
    placement = 'overlay',
  }: { path: string; dir?: boolean; placement?: 'overlay' | 'inline' } = $props();

  const name = $derived(baseName(path));
  let open = $state(false);
  let renaming = $state(false);
  let renameTo = $state('');
  let renameError = $state<string | null>(null);
  let renameBusy = $state(false);

  function openRename() {
    open = false;
    renaming = true;
    renameTo = name;
    renameError = null;
  }

  async function submitRename(e: SubmitEvent) {
    e.preventDefault();
    if (renameBusy) return;
    const to = renameTo.trim();
    const bad = nameError(parentOf(path), to);
    if (bad) {
      renameError = bad;
      return;
    }
    if (to === name) {
      renaming = false;
      return;
    }
    renameBusy = true;
    try {
      await sharedApi.move(path, renameTarget(path, to));
      sharedIndex.invalidate(path);
      renaming = false;
    } catch (err) {
      renameError = attachmentActionText(err);
    } finally {
      renameBusy = false;
    }
  }

  async function remove() {
    open = false;
    const ok = await ui.confirm(deleteConfirm(path, dir));
    if (!ok) return;
    try {
      await sharedApi.remove(path);
      sharedIndex.invalidate(path);
    } catch (err) {
      ui.toast(attachmentActionText(err), 'error');
    }
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
      <MenuItem class="shared-entry-menu-item" icon={Pencil} onclick={openRename}>名前を変更</MenuItem>
      <MenuItem class="shared-entry-menu-item" icon={Trash} danger onclick={() => void remove()}>削除</MenuItem>
    </Menu>
  {/if}
</span>

{#if renaming}
  <Modal title="名前を変更" onclose={() => (renaming = false)} width={380}>
    <form class="attachment-rename" onsubmit={submitRename}>
      <TextInput bind:value={renameTo} aria-label="新しい名前" />
      {#if renameError}<p class="attachment-rename-error" role="alert">{renameError}</p>{/if}
      <p class="muted attachment-rename-note">{renameNote(path)}</p>
      <div class="modal-actions">
        <Button onclick={() => (renaming = false)}>キャンセル</Button>
        <Button type="submit" variant="primary" disabled={renameBusy}>変更</Button>
      </div>
    </form>
  </Modal>
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
  .shared-entry-actions > :global(.shared-entry-menu) {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 5;
  }
  .attachment-rename {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .attachment-rename-error {
    margin: 0;
    color: var(--danger);
    font-size: var(--fs-sm);
  }
  .attachment-rename-note {
    margin: 0;
    font-size: var(--fs-sm);
  }
</style>
