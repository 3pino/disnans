<script lang="ts">
  import { untrack } from 'svelte';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import FileIcon from '@lucide/svelte/icons/file';
  import Folder from '@lucide/svelte/icons/folder';
  import ImageIcon from '@lucide/svelte/icons/image';
  import X from '@lucide/svelte/icons/x';
  import IconButton from './ui/IconButton.svelte';
  import Button from './ui/Button.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { fileExplorer } from '../lib/stores/fileExplorer.svelte';
  import { sharedIndex } from '../lib/stores/sharedIndex.svelte';
  import { breadcrumbs, entryAction, sortEntries } from '../lib/fileExplorer';
  import { sharedFileUrl, fileUrl } from '../lib/config';
  import { formatSize, formatStamp } from '../lib/format';
  import type { SharedEntry } from '../lib/protocol/SharedEntry';

  // 共有フォルダの中身を見るパネル（閲覧だけ。書き込み・削除はしない）。見た目は仮（利用者の確認を取る）。
  // フォルダは中へ、画像は拡大表示、ほかのファイルはリンクで開く・保存する（明示的に押したときだけ）。
  // 一覧は sharedIndex の写し。files.changed で捨てられたら、ここで読み直す。
  const state = $derived(fileExplorer.state);
  const crumbs = $derived(breadcrumbs(fileExplorer.dir));
  const now = Date.now();

  $effect(() => {
    const dir = fileExplorer.dir;
    if (sharedIndex.state(dir) === undefined) untrack(() => sharedIndex.ensure(dir));
  });

  function back(): void {
    if (!fileExplorer.up()) ui.back();
  }

  function href(e: SharedEntry): string {
    return sharedFileUrl(e.path);
  }

  function openImage(e: SharedEntry): void {
    const src = e.file_id ? fileUrl(e.file_id) : href(e);
    ui.lightbox = { src, alt: e.name, downloadUrl: src };
  }
</script>

<div class="file-explorer">
  <header class="file-explorer-header">
    {#if fileExplorer.dir !== '' || ui.isMobile}
      <IconButton label="戻る" onclick={back}><ArrowLeft size={20} /></IconButton>
    {/if}
    <nav class="file-explorer-crumbs" aria-label="場所">
      <button type="button" class="file-explorer-crumb" onclick={() => fileExplorer.open('')}>共有フォルダ</button>
      {#each crumbs as c (c.path)}
        <ChevronRight size={14} />
        <button type="button" class="file-explorer-crumb" onclick={() => fileExplorer.open(c.path)}>{c.name}</button>
      {/each}
    </nav>
    {#if !ui.isMobile}
      <IconButton label="閉じる" onclick={() => ui.closePanel()}><X size={18} /></IconButton>
    {/if}
  </header>

  <div class="scroll file-explorer-body">
    {#if state === undefined || state.kind === 'loading'}
      <p class="file-explorer-status muted">読み込み中…</p>
    {:else if state.kind === 'missing'}
      <p class="file-explorer-status muted">このフォルダは見つかりません。</p>
      <div class="file-explorer-retry"><Button onclick={() => fileExplorer.open('')}>{#snippet children()}共有フォルダへ戻る{/snippet}</Button></div>
    {:else if state.kind === 'error'}
      <p class="file-explorer-status file-explorer-error" role="alert">読み込めませんでした: {state.message}</p>
      <div class="file-explorer-retry"><Button onclick={() => fileExplorer.reload()}>{#snippet children()}再読み込み{/snippet}</Button></div>
    {:else if state.entries.size === 0}
      <p class="file-explorer-status muted">このフォルダには、まだ何もありません。</p>
    {:else}
      <ul class="file-explorer-list">
        {#each sortEntries(state.entries.values()) as e (e.path)}
          {@const action = entryAction(e)}
          <li>
            {#snippet row()}
              <span class="file-explorer-icon">
                {#if action === 'enter'}<Folder size={18} />{:else if action === 'image'}<ImageIcon size={18} />{:else}<FileIcon size={18} />{/if}
              </span>
              <span class="file-explorer-name">{e.name}</span>
              <span class="file-explorer-meta">
                {#if e.kind === 'file'}{formatSize(e.size)} · {/if}{formatStamp(e.modified, now)}
              </span>
            {/snippet}
            {#if action === 'enter'}
              <button type="button" class="file-explorer-row" onclick={() => fileExplorer.open(e.path)}>{@render row()}</button>
            {:else if action === 'image'}
              <button type="button" class="file-explorer-row" onclick={() => openImage(e)}>{@render row()}</button>
            {:else}
              <a class="file-explorer-row" href={href(e)} download={e.name} target="_blank" rel="noopener">{@render row()}</a>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

<style>
  .file-explorer {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--bg);
  }
  .file-explorer-header {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    height: 52px;
    padding: 0 var(--space-4) 0 var(--space-7);
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .file-explorer-crumbs {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    overflow-x: auto;
    white-space: nowrap;
    color: var(--text-muted);
  }
  .file-explorer-crumb {
    padding: var(--space-2) var(--space-3);
    border: none;
    border-radius: var(--radius-xs);
    background: none;
    color: inherit;
  }
  .file-explorer-crumbs > :last-child {
    color: var(--text);
    font-weight: var(--fw-semibold);
  }
  .file-explorer-body {
    flex: 1;
    min-height: 0;
    padding: var(--space-4);
  }
  .file-explorer-status {
    margin: var(--space-8) var(--space-7);
    text-align: center;
  }
  .file-explorer-error {
    color: var(--danger);
    overflow-wrap: anywhere;
  }
  .file-explorer-retry {
    display: flex;
    justify-content: center;
  }
  .file-explorer-list {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .file-explorer-row {
    display: flex;
    align-items: center;
    gap: var(--space-5);
    width: 100%;
    padding: var(--space-4) var(--space-5);
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: inherit;
    text-align: left;
    text-decoration: none;
    font-size: var(--fs-base);
  }
  .file-explorer-icon {
    flex: none;
    display: flex;
    color: var(--text-muted);
  }
  .file-explorer-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .file-explorer-meta {
    flex: none;
    color: var(--text-muted);
    font-size: var(--fs-sm);
  }
  @media (hover: hover) {
    .file-explorer-row:hover {
      background: var(--hover);
    }
  }
</style>
