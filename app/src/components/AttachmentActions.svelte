<script lang="ts">
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Trash from '@lucide/svelte/icons/trash';
  import { attachmentActionText, attachmentNameError } from '../lib/fileLink';
  import { sharedApi } from '../lib/transport/shared';
  import { ui } from '../lib/stores/ui.svelte';
  import IconButton from './ui/IconButton.svelte';
  import Menu from './ui/Menu.svelte';
  import MenuItem from './ui/MenuItem.svelte';
  import Modal from './ui/Modal.svelte';
  import TextInput from './ui/TextInput.svelte';
  import Button from './ui/Button.svelte';

  // 添付（attachments/ の中のファイル）の操作: 名前の変更・削除。どの人も変えられる（サーバーの決まり）。
  // 本文のリンクの中の添付（埋め込み・リンク）と、本文の外の添付のどちらからも使う
  let { name, placement = 'overlay' }: { name: string; placement?: 'overlay' | 'inline' } = $props();

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
    const bad = attachmentNameError(to);
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
      await sharedApi.move(`attachments/${name}`, `attachments/${to}`);
      renaming = false;
    } catch (err) {
      renameError = attachmentActionText(err);
    } finally {
      renameBusy = false;
    }
  }

  async function remove() {
    open = false;
    const ok = await ui.confirm({
      title: `「${name}」を削除しますか`,
      body: '本文のリンクは「削除されたファイル」になります。元に戻せません',
      okLabel: '削除',
      danger: true,
    });
    if (!ok) return;
    try {
      await sharedApi.remove(`attachments/${name}`);
    } catch (err) {
      ui.toast(attachmentActionText(err), 'error');
    }
  }
</script>

<span class="attachment-actions" class:attachment-actions-inline={placement === 'inline'}>
  <IconButton
    class="attachment-action-button"
    label="{name} の操作"
    icon={Ellipsis}
    iconSize={16}
    active={open}
    onclick={() => (open = !open)}
  />
  {#if open}
    <Menu class="attachment-menu" label="添付の操作" onclose={() => (open = false)}>
      <MenuItem class="attachment-menu-item" icon={Pencil} onclick={openRename}>名前を変更</MenuItem>
      <MenuItem class="attachment-menu-item" icon={Trash} danger onclick={() => void remove()}>削除</MenuItem>
    </Menu>
  {/if}
</span>

{#if renaming}
  <Modal title="名前を変更" onclose={() => (renaming = false)} width={380}>
    <form class="attachment-rename" onsubmit={submitRename}>
      <TextInput bind:value={renameTo} aria-label="新しい名前" />
      {#if renameError}<p class="attachment-rename-error" role="alert">{renameError}</p>{/if}
      <p class="muted attachment-rename-note">本文のリンクは、新しい名前で表示されます</p>
      <div class="modal-actions">
        <Button onclick={() => (renaming = false)}>キャンセル</Button>
        <Button type="submit" variant="primary" disabled={renameBusy}>変更</Button>
      </div>
    </form>
  </Modal>
{/if}

<style>
  .attachment-actions {
    position: absolute;
    top: var(--space-2);
    right: var(--space-2);
  }
  .attachment-actions-inline {
    position: relative;
    top: auto;
    right: auto;
    display: inline-flex;
    vertical-align: middle;
  }
  .attachment-actions > :global(.attachment-menu) {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
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
