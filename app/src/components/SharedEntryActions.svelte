<script lang="ts">
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import Copy from '@lucide/svelte/icons/copy';
  import FolderInput from '@lucide/svelte/icons/folder-input';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Scissors from '@lucide/svelte/icons/scissors';
  import Trash from '@lucide/svelte/icons/trash';
  import Info from '@lucide/svelte/icons/info';
  import { attachmentActionText } from '../lib/fileLink';
  import { deleteConfirm, nameError, renameNote, renameTarget } from '../lib/sharedOps';
  import { runTransfer, transferFailure, type TransferItem } from '../lib/sharedTransfer';
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
  import FolderPicker from './FolderPicker.svelte';
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
  let open = $state(false);
  let renaming = $state(false);
  let renameTo = $state('');
  let renameError = $state<string | null>(null);
  let renameBusy = $state(false);
  let moving = $state(false);
  let showProperties = $state(false);

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

  /** コピー・切り取り: バッファに入れる（貼り付けは一覧の「貼り付け」） */
  function toBuffer(mode: 'copy' | 'move') {
    open = false;
    explorerBuffer.set(mode, [item]);
    ui.toast(mode === 'copy' ? `「${name}」をコピーしました。移動先で「貼り付け」を押してください` : `「${name}」を切り取りました。移動先で「貼り付け」を押してください`);
  }

  function openProperties() {
    open = false;
    showProperties = true;
  }

  function openMove() {
    open = false;
    moving = true;
  }

  /** 移動先を選んだあと（同名の確認・決まりは runTransfer） */
  async function moveTo(dest: string, entries: Map<string, SharedEntry>) {
    moving = false;
    const result = await runTransfer({
      op: 'move',
      items: [item],
      destDir: dest,
      destEntries: entries,
      confirm: (c) => ui.confirm(c),
      api: sharedApi,
      invalidate: (p) => sharedIndex.invalidate(p),
    });
    const msg = transferFailure(result);
    if (msg) ui.toast(msg, 'error');
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
      {#if !dir}
        <MenuItem class="shared-entry-menu-item" icon={Copy} onclick={() => toBuffer('copy')}>コピー</MenuItem>
      {/if}
      <MenuItem class="shared-entry-menu-item" icon={Scissors} onclick={() => toBuffer('move')}>切り取り</MenuItem>
      <MenuItem class="shared-entry-menu-item" icon={FolderInput} onclick={openMove}>移動…</MenuItem>
      <MenuItem class="shared-entry-menu-item" icon={Info} onclick={openProperties}>プロパティ</MenuItem>
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

{#if showProperties}
  <FileProperties {entry} onclose={() => (showProperties = false)} />
{/if}

{#if moving}
  <FolderPicker items={[item]} onpick={moveTo} onclose={() => (moving = false)} />
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
