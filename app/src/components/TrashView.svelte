<script lang="ts">
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import IconButton from './ui/IconButton.svelte';
  import PanelBar from './ui/PanelBar.svelte';
  import Button from './ui/Button.svelte';
  import Modal from './ui/Modal.svelte';
  import { explorerTrash } from '../lib/stores/explorerTrash.svelte';
  import { sharedApi } from '../lib/transport/shared';
  import { sharedIndex } from '../lib/stores/sharedIndex.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { attachmentActionText } from '../lib/fileLink';
  import { baseName, parentOf } from '../lib/sharedPath';
  import { formatFull, formatSize } from '../lib/format';
  import { getServerUrl } from '../lib/config';
  import type { SharedTrashEntry } from '../lib/protocol/SharedTrashEntry';

  // ゴミ箱の一覧（ファイルエクスプローラーの ≡ から開く）。見た目は仮（利用者の確認を取る）。
  // 一覧は名前・元の場所・削除日時。「元へ戻す」と「完全削除」（確認必須）。空の表示・エラーと再試行。
  // サーバー変更ガード: 操作開始時のサーバーURLを保持し、変わっていたら操作を拒否。
  let { onclose }: { onclose: () => void } = $props();

  const trashState = $derived(explorerTrash.state);

  // 開いたら一覧を取得する
  $effect(() => {
    if (explorerTrash.state.kind === 'idle') void explorerTrash.load();
  });

  // 操作中の項目を追跡する（同じ項目を二重に操作させない。button disabled に加えて handler でも確認）
  let restoring = $state(new Set<string>());
  let purging = $state(new Set<string>());
  /** 完全削除の確認ダイアログを表示する対象 */
  let purgeConfirmEntry = $state<SharedTrashEntry | null>(null);

  function entryName(e: SharedTrashEntry): string {
    return baseName(e.original_path);
  }

  function entryDir(e: SharedTrashEntry): string {
    const parent = parentOf(e.original_path);
    return parent === '' ? '共有フォルダの直下' : parent;
  }

  async function restore(e: SharedTrashEntry): Promise<void> {
    // 二重操作防止: button disabled でも handler レベルで確認
    if (restoring.has(e.id) || purging.has(e.id)) return;
    // サーバー変更ガード: 開いたときのサーバーと違っていたら拒否
    const scopeUrl = getServerUrl();
    restoring = new Set([...restoring, e.id]);
    try {
      const restored = await sharedApi.restore(e.id);
      // サーバーが操作中に変わった場合はレスポンスを無視
      if (getServerUrl() !== scopeUrl) return;
      explorerTrash.removeEntry(e.id);
      sharedIndex.invalidate(restored.path);
      ui.toast(`「${entryName(e)}」を元の場所に戻しました`);
    } catch (err) {
      if (getServerUrl() !== scopeUrl) return;
      ui.toast(`元に戻せませんでした: ${attachmentActionText(err)}`, 'error');
    } finally {
      restoring = new Set([...restoring].filter((x) => x !== e.id));
    }
  }

  async function purge(e: SharedTrashEntry): Promise<void> {
    // 二重操作防止
    if (purging.has(e.id) || restoring.has(e.id)) return;
    const scopeUrl = getServerUrl();
    purgeConfirmEntry = null;
    purging = new Set([...purging, e.id]);
    try {
      await sharedApi.purge(e.id);
      if (getServerUrl() !== scopeUrl) return;
      explorerTrash.removeEntry(e.id);
    } catch (err) {
      if (getServerUrl() !== scopeUrl) return;
      ui.toast(`削除できませんでした: ${attachmentActionText(err)}`, 'error');
    } finally {
      purging = new Set([...purging].filter((x) => x !== e.id));
    }
  }
</script>

<div class="trash-view">
  <PanelBar class="trash-bar">
    <div class="trash-bar-left">
      <IconButton label="ファイル一覧に戻る" onclick={onclose}><ArrowLeft size={18} /></IconButton>
      <span class="trash-title">ゴミ箱</span>
    </div>
    {#snippet actions()}
      {#if trashState.kind !== 'idle'}
        <IconButton label="再読み込み" title="再読み込み" onclick={() => void explorerTrash.load()}><RefreshCw size={16} /></IconButton>
      {/if}
    {/snippet}
  </PanelBar>

  <div class="scroll trash-body">
    {#if trashState.kind === 'loading' || trashState.kind === 'idle'}
      <p class="trash-status muted">読み込み中…</p>
    {:else if trashState.kind === 'error'}
      <p class="trash-status trash-error" role="alert">読み込めませんでした: {trashState.message}</p>
      <div class="trash-retry"><Button onclick={() => void explorerTrash.load()}>再読み込み</Button></div>
    {:else if trashState.entries.length === 0}
      <p class="trash-status muted">ゴミ箱は空です。</p>
    {:else}
      <ul class="trash-list">
        {#each trashState.entries as e (e.id)}
          <li class="trash-item">
            <div class="trash-item-info">
              <span class="trash-item-name">{entryName(e)}</span>
              <span class="trash-item-dir muted">{entryDir(e)}</span>
              <span class="trash-item-meta muted">
                {formatFull(e.deleted_at)}
                {#if e.size > 0}・{formatSize(e.size)}{/if}
              </span>
            </div>
            <div class="trash-item-actions">
              <Button
                onclick={() => void restore(e)}
                disabled={restoring.has(e.id) || purging.has(e.id)}
                title="元の場所に戻す"
              >{#snippet children()}{#if restoring.has(e.id)}戻し中…{:else}<RotateCcw size={13} /> 元へ戻す{/if}{/snippet}</Button>
              <IconButton
                label="{entryName(e)} を完全削除"
                title="完全削除（取り消せません）"
                disabled={restoring.has(e.id) || purging.has(e.id)}
                onclick={() => (purgeConfirmEntry = e)}
              ><Trash2 size={15} /></IconButton>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

<!-- 完全削除の確認（Modal を使って項目名と「取り消せません」を明示） -->
{#if purgeConfirmEntry}
  {@const pe = purgeConfirmEntry}
  <Modal
    title="完全に削除しますか"
    onclose={() => (purgeConfirmEntry = null)}
    width={360}
  >
    <p class="trash-purge-body">「{entryName(pe)}」を完全に削除します。<strong>取り消せません。</strong></p>
    <div class="modal-actions">
      <Button onclick={() => (purgeConfirmEntry = null)}>キャンセル</Button>
      <Button variant="danger" disabled={purging.has(pe.id)} onclick={() => void purge(pe)}>
        {#snippet children()}{purging.has(pe.id) ? '削除中…' : '完全削除'}{/snippet}
      </Button>
    </div>
  </Modal>
{/if}

<style>
  .trash-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--bg);
  }
  .trash-bar-left {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }
  .trash-title {
    font-size: var(--fs-base);
    font-weight: var(--fw-semibold);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .trash-body {
    flex: 1;
    min-height: 0;
    padding: var(--space-4);
  }
  .trash-status {
    margin: var(--space-8) var(--space-7);
    text-align: center;
  }
  .trash-error {
    color: var(--danger);
    overflow-wrap: anywhere;
  }
  .trash-retry {
    display: flex;
    justify-content: center;
  }
  .trash-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .trash-item {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-2);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--surface-2);
    min-width: 0;
  }
  .trash-item-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .trash-item-name {
    font-weight: var(--fw-semibold);
    font-size: var(--fs-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .trash-item-dir,
  .trash-item-meta {
    font-size: var(--fs-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .trash-item-actions {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .trash-purge-body {
    margin: 0 0 var(--space-4);
    font-size: var(--fs-sm);
  }
</style>
