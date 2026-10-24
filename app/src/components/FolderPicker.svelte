<script lang="ts">
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Folder from '@lucide/svelte/icons/folder';
  import CornerLeftUp from '@lucide/svelte/icons/corner-left-up';
  import Button from './ui/Button.svelte';
  import Modal from './ui/Modal.svelte';
  import { attachmentActionText } from '../lib/fileLink';
  import { breadcrumbs, sortEntries } from '../lib/fileExplorer';
  import { checkTransfer, type TransferItem } from '../lib/sharedTransfer';
  import { childPath } from '../lib/sharedOps';
  import { sharedApi } from '../lib/transport/shared';
  import { parentOf } from '../lib/sharedPath';
  import type { SharedEntry } from '../lib/protocol/SharedEntry';

  // 移動先のフォルダを選ぶ（共有フォルダの中を歩いて選ぶ）。移動できない先は理由を出し、「ここへ移動」を出さない。
  // 一覧は直接読む（共有フォルダの写しを使わない）。見た目は仮
  let {
    items,
    onpick,
    onclose,
  }: {
    items: TransferItem[];
    /** 選んだフォルダと、その中身（同名の確認に使う） */
    onpick: (dest: string, entries: Map<string, SharedEntry>) => void;
    onclose: () => void;
  } = $props();

  // 最初に開くフォルダは、最初の項目のあるフォルダ（項目の変化には追わない）
  // svelte-ignore state_referenced_locally
  let dir = $state(parentOf(items[0]?.path ?? ''));
  let listing = $state<{ kind: 'loading' } | { kind: 'ok'; entries: SharedEntry[] } | { kind: 'error'; message: string }>({ kind: 'loading' });

  $effect(() => {
    const d = dir;
    let alive = true;
    listing = { kind: 'loading' };
    sharedApi.list(d).then(
      (entries) => {
        if (alive) listing = { kind: 'ok', entries };
      },
      (e: unknown) => {
        if (alive) listing = { kind: 'error', message: attachmentActionText(e) };
      },
    );
    return () => {
      alive = false;
    };
  });

  const folders = $derived(listing.kind === 'ok' ? sortEntries(listing.entries.filter((e) => e.kind === 'dir')) : []);
  const crumbs = $derived(breadcrumbs(dir));
  /** 移動できない理由（最初の 1 件）。移動先を変えると決め直す */
  const reason = $derived.by(() => {
    for (const i of items) {
      const c = checkTransfer('move', i, dir);
      if (!c.ok) return c.message;
    }
    return null;
  });

  function pick(): void {
    if (listing.kind !== 'ok') return;
    onpick(dir, new Map(listing.entries.map((e) => [e.name, e])));
  }
</script>

<Modal title="移動先を選ぶ" onclose={onclose} width={420}>
  <div class="folder-picker">
    <nav class="folder-picker-crumbs" aria-label="場所">
      <button type="button" class="folder-picker-crumb" onclick={() => (dir = '')}>共有フォルダ</button>
      {#each crumbs as c (c.path)}
        <ChevronRight size={14} />
        <button type="button" class="folder-picker-crumb" onclick={() => (dir = c.path)}>{c.name}</button>
      {/each}
    </nav>
    {#if dir !== ''}
      <button type="button" class="folder-picker-item" onclick={() => (dir = parentOf(dir))}>
        <CornerLeftUp size={18} /><span>上のフォルダへ</span>
      </button>
    {/if}
    <div class="folder-picker-list scroll">
      {#if listing.kind === 'loading'}
        <p class="muted folder-picker-status">読み込み中…</p>
      {:else if listing.kind === 'error'}
        <p class="folder-picker-status folder-picker-error" role="alert">読めませんでした: {listing.message}</p>
      {:else if folders.length === 0}
        <p class="muted folder-picker-status">このフォルダには、フォルダがありません。</p>
      {:else}
        {#each folders as f (f.path)}
          <button type="button" class="folder-picker-item" onclick={() => (dir = childPath(dir, f.name))}>
            <Folder size={18} /><span>{f.name}</span>
          </button>
        {/each}
      {/if}
    </div>
    {#if reason}<p class="folder-picker-reason" role="note">{reason}</p>{/if}
    <div class="modal-actions">
      <Button onclick={onclose}>キャンセル</Button>
      <Button variant="primary" disabled={!!reason || listing.kind !== 'ok'} onclick={pick}>ここへ移動</Button>
    </div>
  </div>
</Modal>

<style>
  .folder-picker {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .folder-picker-crumbs {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    color: var(--text-muted);
  }
  .folder-picker-crumb {
    padding: var(--space-2) var(--space-3);
    border: none;
    border-radius: var(--radius-xs);
    background: none;
    color: inherit;
  }
  .folder-picker-list {
    max-height: 50vh;
    display: flex;
    flex-direction: column;
  }
  .folder-picker-item {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: inherit;
    text-align: left;
  }
  .folder-picker-status {
    margin: var(--space-4);
  }
  .folder-picker-error,
  .folder-picker-reason {
    margin: 0;
    color: var(--danger);
    font-size: var(--fs-sm);
    overflow-wrap: anywhere;
  }
</style>
