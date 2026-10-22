<script lang="ts">
  import FileIcon from '@lucide/svelte/icons/file';
  import FileX from '@lucide/svelte/icons/file-x';
  import Download from '@lucide/svelte/icons/download';
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Trash from '@lucide/svelte/icons/trash';
  import type { Attachment } from '../lib/protocol/Attachment';
  import { fileUrl } from '../lib/config';
  import { formatSize } from '../lib/format';
  import { attachmentActionText, attachmentNameError } from '../lib/fileLink';
  import { sharedApi } from '../lib/transport/shared';
  import { ui } from '../lib/stores/ui.svelte';
  import IconButton from './ui/IconButton.svelte';
  import Menu from './ui/Menu.svelte';
  import MenuItem from './ui/MenuItem.svelte';
  import Modal from './ui/Modal.svelte';
  import TextInput from './ui/TextInput.svelte';
  import Button from './ui/Button.svelte';

  let { attachments, local = {} }: { attachments: Attachment[]; local?: Record<string, string> } = $props();

  // 削除された添付は名前だけ出し、開けない。残りが今ある添付
  const live = $derived(attachments.filter((a) => !a.deleted));
  const gone = $derived(attachments.filter((a) => a.deleted));
  const images = $derived(live.filter((a) => a.mime.startsWith('image/')));
  const files = $derived(live.filter((a) => !a.mime.startsWith('image/')));

  function thumbSrc(a: Attachment): string {
    return local[a.id] ?? fileUrl(a.id, a.has_thumb);
  }

  // 表示サイズ: 長辺 320px 程度に収める
  function box(a: Attachment): { w: number; h: number } | null {
    if (!a.width || !a.height) return null;
    const max = images.length > 1 ? 200 : 320;
    const s = Math.min(1, max / Math.max(a.width, a.height));
    return { w: Math.round(a.width * s), h: Math.round(a.height * s) };
  }

  // ---- 添付の操作（名前の変更・削除）。どの人も変えられる（サーバーの決まり）。変わったことは files.changed で全員に届く ----

  /** メニューを開いている添付の ID */
  let menuFor = $state<string | null>(null);
  /** 名前を変えているもの */
  let renaming = $state<Attachment | null>(null);
  let renameTo = $state('');
  let renameError = $state<string | null>(null);
  let renameBusy = $state(false);

  function openRename(a: Attachment) {
    menuFor = null;
    renaming = a;
    renameTo = a.file_name;
    renameError = null;
  }

  async function submitRename(e: SubmitEvent) {
    e.preventDefault();
    const a = renaming;
    if (!a || renameBusy) return;
    const to = renameTo.trim();
    const bad = attachmentNameError(to);
    if (bad) {
      renameError = bad;
      return;
    }
    if (to === a.file_name) {
      renaming = null;
      return;
    }
    renameBusy = true;
    try {
      await sharedApi.move(`attachments/${a.file_name}`, `attachments/${to}`);
      renaming = null;
    } catch (err) {
      renameError = attachmentActionText(err);
    } finally {
      renameBusy = false;
    }
  }

  async function remove(a: Attachment) {
    menuFor = null;
    const ok = await ui.confirm({
      title: `「${a.file_name}」を削除しますか`,
      body: '本文のリンクは「削除されたファイル」になります。元に戻せません',
      okLabel: '削除',
      danger: true,
    });
    if (!ok) return;
    try {
      await sharedApi.remove(`attachments/${a.file_name}`);
    } catch (err) {
      ui.toast(attachmentActionText(err), 'error');
    }
  }
</script>

{#snippet actions(a: Attachment)}
  <span class="attachment-actions">
    <IconButton
      class="attachment-action-button"
      label="{a.file_name} の操作"
      icon={Ellipsis}
      iconSize={16}
      active={menuFor === a.id}
      onclick={() => (menuFor = menuFor === a.id ? null : a.id)}
    />
    {#if menuFor === a.id}
      <Menu class="attachment-menu" label="添付の操作" onclose={() => (menuFor = null)}>
        <MenuItem class="attachment-menu-item" icon={Pencil} onclick={() => openRename(a)}>名前を変更</MenuItem>
        <MenuItem class="attachment-menu-item" icon={Trash} danger onclick={() => void remove(a)}>削除</MenuItem>
      </Menu>
    {/if}
  </span>
{/snippet}

{#if images.length > 0}
  <div class="attachment-images">
    {#each images as a (a.id)}
      {@const b = box(a)}
      <div class="attachment-item">
        <button
          type="button"
          class="attachment-image"
          style:width={b ? `${b.w}px` : undefined}
          style:aspect-ratio={b ? `${b.w} / ${b.h}` : undefined}
          onclick={() => (ui.lightbox = { src: local[a.id] ?? fileUrl(a.id), alt: a.file_name, downloadUrl: fileUrl(a.id) })}
          aria-label="{a.file_name} を開く"
        >
          <img class="attachment-image-thumb" src={thumbSrc(a)} alt={a.file_name} loading="lazy" decoding="async" />
        </button>
        {@render actions(a)}
      </div>
    {/each}
  </div>
{/if}

{#if files.length > 0}
  <div class="attachment-files">
    {#each files as a (a.id)}
      <div class="attachment-item">
        <a class="attachment-file" href={fileUrl(a.id)} download={a.file_name} target="_blank" rel="noopener">
          <FileIcon size={18} />
          <span class="attachment-file-name">{a.file_name}</span>
          <span class="attachment-file-size">{formatSize(a.size)}</span>
          <Download size={16} />
        </a>
        {@render actions(a)}
      </div>
    {/each}
  </div>
{/if}

{#if gone.length > 0}
  <div class="attachment-files">
    {#each gone as a (a.id)}
      <div class="attachment-file attachment-file-deleted" role="note">
        <FileX size={18} />
        <span class="attachment-file-name">{a.file_name}</span>
        <span class="attachment-file-size">削除されたファイル</span>
      </div>
    {/each}
  </div>
{/if}

{#if renaming}
  <Modal title="名前を変更" onclose={() => (renaming = null)} width={380}>
    <form class="attachment-rename" onsubmit={submitRename}>
      <TextInput bind:value={renameTo} aria-label="新しい名前" />
      {#if renameError}<p class="attachment-rename-error" role="alert">{renameError}</p>{/if}
      <p class="muted attachment-rename-note">本文のリンクは、新しい名前で表示されます</p>
      <div class="modal-actions">
        <Button onclick={() => (renaming = null)}>キャンセル</Button>
        <Button type="submit" variant="primary" disabled={renameBusy}>変更</Button>
      </div>
    </form>
  </Modal>
{/if}

<style>
  .attachment-item {
    position: relative;
    display: inline-flex;
    max-width: 100%;
  }
  .attachment-actions {
    position: absolute;
    top: var(--space-2);
    right: var(--space-2);
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
  .attachment-file-deleted {
    color: var(--text-muted);
    font-style: italic;
  }
  .attachment-images {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    margin-top: var(--space-3);
  }
  .attachment-image {
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: var(--surface-2);
    max-width: 100%;
    min-width: 60px;
    min-height: 60px;
    cursor: zoom-in;
  }
  .attachment-image .attachment-image-thumb {
    display: block;
    width: 100%;
    height: 100%;
    max-height: 320px;
    object-fit: cover;
  }
  .attachment-files {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2);
    margin-top: var(--space-3);
  }
  .attachment-file {
    display: inline-flex;
    align-items: center;
    gap: var(--space-4);
    max-width: 100%;
    padding: var(--space-4) var(--space-6);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    text-decoration: none;
    font-size: var(--fs-base);
  }
  .attachment-file:hover {
    border-color: var(--border-hover);
  }
  .attachment-file-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .attachment-file-size {
    color: var(--text-muted);
    font-size: var(--fs-sm);
    flex: none;
  }
</style>
