<script lang="ts">
  import { untrack } from 'svelte';
  import FileIcon from '@lucide/svelte/icons/file';
  import FileX from '@lucide/svelte/icons/file-x';
  import Folder from '@lucide/svelte/icons/folder';
  import Download from '@lucide/svelte/icons/download';
  import { client } from '../lib/stores/client.svelte';
  import { sharedIndex } from '../lib/stores/sharedIndex.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { deletedAttachmentNames, fileLinkView } from '../lib/fileLink';
  import { formatSize } from '../lib/format';
  import { baseName, parentOf } from '../lib/sharedPath';
  import AttachmentActions from './AttachmentActions.svelte';

  // 本文のファイルリンク（`[別名](パス)`）と埋め込み（`![…](パス)`）。どちらも共有フォルダのパスを今の一覧と突き合わせて表す。
  // 見た目は仮（利用者の確認を取る）。判断の決まりは lib/fileLink.ts
  let { path, alias, embed }: { path: string; alias: string | null; embed: boolean } = $props();

  // 一覧が手元になければ読む（files.changed で捨てられたら、ここで読み直す）
  $effect(() => {
    const dir = parentOf(path);
    if (sharedIndex.state(dir) === undefined) untrack(() => sharedIndex.ensure(dir));
  });

  const deleted = $derived(deletedAttachmentNames(client.timeline().messages));
  const view = $derived(fileLinkView({ path, alias, embed }, sharedIndex.file(path), deleted));

  /** 埋め込みの画像が読めなかった（消えた・取れない） */
  let broken = $state(false);
</script>

{#snippet content()}
{#if view.kind === 'pending'}
  <span class="file-link file-link-pending">{view.text}</span>
{:else if view.kind === 'missing' || (view.kind === 'embedImage' && broken)}
  <span class="file-link file-link-missing" role="note">見つからないファイル{view.kind === 'missing' ? `（${view.text}）` : ''}</span>
{:else if view.kind === 'deleted'}
  <span class="file-link file-link-deleted" role="note"><FileX size={14} />削除されたファイル（{view.name}）</span>
{:else if view.kind === 'folder'}
  <span class="file-link-folder"><Folder size={14} />{view.text}</span>
{:else if view.kind === 'link'}
  <a class="file-link inline-link" href={view.href} download={view.name} target="_blank" rel="noopener">{view.text}</a>
{:else if view.kind === 'image'}
  <button type="button" class="file-link file-link-button" onclick={() => (ui.lightbox = { src: view.src, alt: view.alt, downloadUrl: view.src })}>{view.text}</button>
{:else if view.kind === 'embedImage'}
  <button
    type="button"
    class="file-link-embed-image"
    aria-label="{view.alt} を開く"
    onclick={() => (ui.lightbox = { src: view.src, alt: view.alt, downloadUrl: view.src })}
  >
    <img class="file-link-embed-image-img" src={view.src} alt={view.alt} loading="lazy" decoding="async" onerror={() => (broken = true)} />
  </button>
{:else if view.kind === 'embedFile'}
  <a class="file-link-card" href={view.href} download={view.name} target="_blank" rel="noopener">
    <FileIcon size={18} />
    <span class="file-link-card-name">{view.name}</span>
    <span class="file-link-card-size">{formatSize(view.size)}</span>
    <Download size={16} />
  </a>
{/if}
{/snippet}

<!-- 添付（attachments/ の中）は、名前の変更・削除の「…」を付ける。埋め込みは右上に重ね、リンクは文字の後ろに続ける -->
{#if path.startsWith('attachments/') && (view.kind === 'link' || view.kind === 'image' || view.kind === 'embedImage' || view.kind === 'embedFile')}
  <span class="file-link-attachment">
    {@render content()}
    <AttachmentActions name={baseName(path)} placement={view.kind === 'embedImage' || view.kind === 'embedFile' ? 'overlay' : 'inline'} />
  </span>
{:else}
  {@render content()}
{/if}

<style>
  .file-link-attachment {
    position: relative;
    display: inline-block;
    max-width: 100%;
  }
  .file-link-pending,
  .file-link-missing,
  .file-link-deleted,
  .file-link-folder {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--text-muted);
  }
  .file-link-deleted,
  .file-link-missing {
    font-style: italic;
  }
  .file-link-button {
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    font: inherit;
    text-decoration: underline;
    cursor: zoom-in;
  }
  .file-link-embed-image {
    display: inline-block;
    max-width: 100%;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: var(--surface-2);
    vertical-align: top;
    cursor: zoom-in;
  }
  .file-link-embed-image-img {
    display: block;
    max-width: 100%;
    max-height: 320px;
    object-fit: contain;
  }
  .file-link-card {
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
  .file-link-card:hover {
    border-color: var(--border-hover);
  }
  .file-link-card-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .file-link-card-size {
    color: var(--text-muted);
    font-size: var(--fs-sm);
    flex: none;
  }
</style>
