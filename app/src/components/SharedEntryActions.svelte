<script lang="ts">
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import Copy from '@lucide/svelte/icons/copy';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Scissors from '@lucide/svelte/icons/scissors';
  import Trash from '@lucide/svelte/icons/trash';
  import Info from '@lucide/svelte/icons/info';
  import { attachmentActionText } from '../lib/fileLink';
  import { deleteConfirm, nameError, renameAllowed, renameNote, renameTarget } from '../lib/sharedOps';
  import { checkTransfer, type TransferItem } from '../lib/sharedTransfer';
  import { sharedApi } from '../lib/transport/shared';
  import { sharedIndex } from '../lib/stores/sharedIndex.svelte';
  import { explorerBuffer } from '../lib/stores/explorerBuffer.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { parentOf, baseName } from '../lib/sharedPath';
  import type { SharedEntry } from '../lib/protocol/SharedEntry';
  import IconButton from './ui/IconButton.svelte';
  import Menu from './ui/Menu.svelte';
  import MenuItem from './ui/MenuItem.svelte';
  import Modal from './ui/Modal.svelte';
  import TextInput from './ui/TextInput.svelte';
  import Button from './ui/Button.svelte';
  import FileProperties from './FileProperties.svelte';

  // 共有フォルダの項目の操作（「…」）: 名前の変更・コピー・切り取り・移動・削除。どの人も変えられる（サーバーの決まり）。
  // 変わったことは files.changed で全員に届く。コピー・切り取りはアプリ内のバッファに入れ、貼り付けは一覧の「貼り付け」で行う
  let {
    entry,
    placement = 'overlay',
  }: { entry: SharedEntry; placement?: 'overlay' | 'inline' } = $props();

  const path = $derived(entry.path);
  const name = $derived(baseName(path));
  const dir = $derived(entry.kind === 'dir');
  const item = $derived<TransferItem>({ path, kind: entry.kind === 'dir' ? 'dir' : 'file' });
  /** 名前の変更・削除・切り取りが今できるか（できないものはグレーにして理由を出す） */
  const renameRule = $derived(renameAllowed(path));
  const cutRule = $derived(checkTransfer('move', item, parentOf(path)));
  let open = $state(false);
  let renaming = $state(false);
  let renameTo = $state('');
  let renameError = $state<string | null>(null);
  let renameBusy = $state(false);
  let showProperties = $state(false);

  function openRename() {
    if (!renameRule.ok) return;
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

  /** コピー・切り取り: バッファに入れる（貼り付けは一覧の「貼り付け」。できたことは、貼り付けが押せるようになることで分かるので通知は出さない） */
  function toBuffer(mode: 'copy' | 'move') {
    open = false;
    explorerBuffer.set(mode, [item]);
  }

  function openProperties() {
    open = false;
    showProperties = true;
  }

  async function remove() {
    if (!renameRule.ok) return;
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
      <MenuItem class="shared-entry-menu-item" icon={Pencil} disabled={!renameRule.ok} reason={renameRule.ok ? undefined : renameRule.message} onclick={openRename}>名前を変更</MenuItem>
      {#if !dir}
        <MenuItem class="shared-entry-menu-item" icon={Copy} onclick={() => toBuffer('copy')}>コピー</MenuItem>
      {/if}
      <MenuItem class="shared-entry-menu-item" icon={Scissors} disabled={!cutRule.ok} reason={cutRule.ok ? undefined : cutRule.message} onclick={() => toBuffer('move')}>切り取り</MenuItem>
      <MenuItem class="shared-entry-menu-item" icon={Info} onclick={openProperties}>プロパティ</MenuItem>
      <MenuItem class="shared-entry-menu-item" icon={Trash} danger disabled={!renameRule.ok} reason={renameRule.ok ? undefined : renameRule.message} onclick={() => void remove()}>削除</MenuItem>
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
