<script lang="ts">
  import { untrack } from 'svelte';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import FileIcon from '@lucide/svelte/icons/file';
  import Folder from '@lucide/svelte/icons/folder';
  import ImageIcon from '@lucide/svelte/icons/image';
  import Upload from '@lucide/svelte/icons/upload';
  import FolderPlus from '@lucide/svelte/icons/folder-plus';
  import X from '@lucide/svelte/icons/x';
  import IconButton from './ui/IconButton.svelte';
  import Button from './ui/Button.svelte';
  import Modal from './ui/Modal.svelte';
  import TextInput from './ui/TextInput.svelte';
  import SharedEntryActions from './SharedEntryActions.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { fileExplorer } from '../lib/stores/fileExplorer.svelte';
  import { sharedIndex } from '../lib/stores/sharedIndex.svelte';
  import { breadcrumbs, entryAction, sortEntries } from '../lib/fileExplorer';
  import { attachmentActionText } from '../lib/fileLink';
  import { canOperate, childPath, inAttachments, nameError, overwriteConfirm, planUpload } from '../lib/sharedOps';
  import { sharedApi, uploadShared } from '../lib/transport/shared';
  import { sharedFileUrl, fileUrl } from '../lib/config';
  import { formatSize, formatStamp } from '../lib/format';
  import type { SharedEntry } from '../lib/protocol/SharedEntry';

  // 共有フォルダの中身を見るパネル（閲覧だけ。書き込み・削除はしない）。見た目は仮（利用者の確認を取る）。
  // フォルダは中へ、画像は拡大表示、ほかのファイルはリンクで開く・保存する（明示的に押したときだけ）。
  // 一覧は sharedIndex の写し。files.changed で捨てられたら、ここで読み直す。
  const listing = $derived(fileExplorer.state);
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

  // ---- 書き込み（アップロード・新しいフォルダ）。どの人も変えられる。変わったことは files.changed で全員に届く ----

  /** 送信の 1 件（進み・失敗・中止）。送信中と失敗だけ並べ、成功したら消す */
  type Upload = { key: number; name: string; ratio: number; error: string | null; abort: (() => void) | null };
  let uploads = $state<Upload[]>([]);
  let uploadSeq = 0;
  let fileInput: HTMLInputElement | undefined = $state();

  /** attachments/ の中では新しいフォルダは作れない（中はファイルだけ） */
  const canCreateFolder = $derived(!inAttachments(fileExplorer.dir));

  function dropUpload(key: number): void {
    const u = uploads.find((x) => x.key === key);
    u?.abort?.();
    uploads = uploads.filter((x) => x.key !== key);
  }

  async function onPicked(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const picked = [...(input.files ?? [])];
    input.value = '';
    // 開いたフォルダに送る（途中でフォルダを移っても、最初のフォルダへ送る）
    const dir = fileExplorer.dir;
    for (const file of picked) await sendOne(dir, file);
  }

  /** 1 件を送る。同名があれば確認してから上書きする（確認なしには上書きしない） */
  async function sendOne(dir: string, file: File): Promise<void> {
    uploads.push({ key: ++uploadSeq, name: file.name, ratio: 0, error: null, abort: null });
    const row = uploads[uploads.length - 1];
    const plan = planUpload(dir, file.name, sharedIndex.state(dir) ?? { kind: 'loading' });
    if (plan.kind === 'blocked') {
      row.error = plan.message;
      return;
    }
    if (plan.kind === 'overwrite' && !(await ui.confirm(overwriteConfirm(plan.path)))) {
      dropUpload(row.key);
      return;
    }
    const h = uploadShared(plan.path, file, (r) => (row.ratio = r));
    row.abort = h.abort;
    try {
      await h.promise;
      dropUpload(row.key);
      sharedIndex.invalidate(plan.path);
    } catch (err) {
      // 中止（×で消した）は、失敗として出さない
      if (!uploads.some((x) => x.key === row.key)) return;
      row.abort = null;
      const aborted = err && typeof err === 'object' && (err as { code?: unknown }).code === 'aborted';
      if (aborted) dropUpload(row.key);
      else row.error = attachmentActionText(err);
    }
  }

  let mkdirOpen = $state(false);
  let mkdirName = $state('');
  let mkdirError = $state<string | null>(null);
  let mkdirBusy = $state(false);

  function openMkdir(): void {
    mkdirName = '';
    mkdirError = null;
    mkdirOpen = true;
  }

  async function submitMkdir(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (mkdirBusy) return;
    const dir = fileExplorer.dir;
    const name = mkdirName.trim();
    const bad = nameError(dir, name);
    if (bad) {
      mkdirError = bad;
      return;
    }
    const path = childPath(dir, name);
    mkdirBusy = true;
    try {
      await sharedApi.mkdir(path);
      sharedIndex.invalidate(path);
      mkdirOpen = false;
    } catch (err) {
      mkdirError = attachmentActionText(err);
    } finally {
      mkdirBusy = false;
    }
  }
</script>

<div class="file-explorer">
  <!-- 上端の行は通話・設定の見出しと同じ（.top-bar が上の余白を取る）。戻る・場所・操作・閉じるを 1 行に並べる -->
  <div class="top-bar file-explorer-bar">
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
    <IconButton label="アップロード" title="アップロード" onclick={() => fileInput?.click()}><Upload size={18} /></IconButton>
    {#if canCreateFolder}
      <IconButton label="新しいフォルダ" title="新しいフォルダ" onclick={openMkdir}><FolderPlus size={18} /></IconButton>
    {/if}
    <input bind:this={fileInput} type="file" multiple hidden onchange={onPicked} />
    {#if !ui.isMobile}
      <IconButton label="閉じる" onclick={() => ui.closePanel()}><X size={18} /></IconButton>
    {/if}
  </div>

  {#if uploads.length > 0}
    <ul class="file-explorer-uploads" aria-label="送信中のファイル">
      {#each uploads as u (u.key)}
        <li class="file-explorer-upload" class:file-explorer-upload-failed={u.error !== null}>
          <span class="file-explorer-upload-name">{u.name}</span>
          {#if u.error}
            <span class="file-explorer-upload-error" role="alert">{u.error}</span>
          {:else}
            <span class="file-explorer-upload-progress">{Math.round(u.ratio * 100)}%</span>
          {/if}
          <IconButton label="{u.name} を取り消す" onclick={() => dropUpload(u.key)}><X size={14} /></IconButton>
        </li>
      {/each}
    </ul>
  {/if}

  <div class="scroll file-explorer-body">
    {#if listing === undefined || listing.kind === 'loading'}
      <p class="file-explorer-status muted">読み込み中…</p>
    {:else if listing.kind === 'missing'}
      <p class="file-explorer-status muted">このフォルダは見つかりません。</p>
      <div class="file-explorer-retry"><Button onclick={() => fileExplorer.open('')}>{#snippet children()}共有フォルダへ戻る{/snippet}</Button></div>
    {:else if listing.kind === 'error'}
      <p class="file-explorer-status file-explorer-error" role="alert">読み込めませんでした: {listing.message}</p>
      <div class="file-explorer-retry"><Button onclick={() => fileExplorer.reload()}>{#snippet children()}再読み込み{/snippet}</Button></div>
    {:else if listing.entries.size === 0}
      <p class="file-explorer-status muted">このフォルダには、まだ何もありません。</p>
    {:else}
      <ul class="file-explorer-list">
        {#each sortEntries(listing.entries.values()) as e (e.path)}
          {@const action = entryAction(e)}
          <li class="file-explorer-item">
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
            {#if canOperate(e.path)}
              <SharedEntryActions path={e.path} dir={e.kind === 'dir'} placement="inline" />
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

{#if mkdirOpen}
  <Modal title="新しいフォルダ" onclose={() => (mkdirOpen = false)} width={380}>
    <form class="file-explorer-mkdir" onsubmit={submitMkdir}>
      <TextInput bind:value={mkdirName} aria-label="フォルダの名前" />
      {#if mkdirError}<p class="file-explorer-mkdir-error" role="alert">{mkdirError}</p>{/if}
      <div class="modal-actions">
        <Button onclick={() => (mkdirOpen = false)}>キャンセル</Button>
        <Button type="submit" variant="primary" disabled={mkdirBusy}>作成</Button>
      </div>
    </form>
  </Modal>
{/if}

<style>
  .file-explorer {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--bg);
  }
  /* 上端の行（通話・設定の見出しと同じ余白。上の安全域は .top-bar が取る）。右の操作は左の場所に続けて並べる */
  .file-explorer-bar {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    /* 上の余白は .top-bar のものを使う（ここで padding を省略形で書くと、上まで消してしまう） */
    padding-right: var(--space-4);
    padding-bottom: var(--space-3);
    padding-left: var(--space-7);
    border-bottom: 1px solid var(--border);
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
  .file-explorer-uploads {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin: 0;
    padding: var(--space-3) var(--space-4);
    list-style: none;
    border-bottom: 1px solid var(--border);
    flex: none;
    font-size: var(--fs-sm);
  }
  .file-explorer-upload {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
  }
  .file-explorer-upload-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .file-explorer-upload-progress,
  .file-explorer-upload-error {
    flex: none;
    color: var(--text-muted);
  }
  .file-explorer-upload-failed .file-explorer-upload-error {
    color: var(--danger);
    overflow-wrap: anywhere;
  }
  .file-explorer-mkdir {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .file-explorer-mkdir-error {
    margin: 0;
    color: var(--danger);
    font-size: var(--fs-sm);
  }
  .file-explorer-item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }
  .file-explorer-row {
    display: flex;
    align-items: center;
    gap: var(--space-5);
    flex: 1;
    min-width: 0;
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
