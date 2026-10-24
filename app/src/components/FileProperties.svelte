<script lang="ts">
  import Modal from './ui/Modal.svelte';
  import { formatFull, formatSize } from '../lib/format';
  import { kindLabel } from '../lib/fileExplorer';
  import type { SharedEntry } from '../lib/protocol/SharedEntry';

  // 項目のプロパティ（読むだけ）。作成日時はサーバーが持たないので出さない（更新日時だけ）。
  // 添付は ID と、投稿されたメッセージ（message_id）を出す。見た目は仮
  let { entry, onclose }: { entry: SharedEntry; onclose: () => void } = $props();
  const isFile = $derived(entry.kind === 'file');
</script>

<Modal title="プロパティ" {onclose} width={380}>
  <dl class="file-properties">
    <dt>名前</dt>
    <dd>{entry.name}</dd>
    <dt>パス</dt>
    <dd class="file-properties-path">{entry.path}</dd>
    <dt>種類</dt>
    <dd>{kindLabel(entry)}{#if entry.mime} <span class="muted">（{entry.mime}）</span>{/if}</dd>
    <dt>サイズ</dt>
    <dd>{isFile ? `${formatSize(entry.size)}（${entry.size.toLocaleString('ja-JP')} バイト）` : 'フォルダ'}</dd>
    <dt>更新日時</dt>
    <dd>{entry.modified > 0 ? formatFull(entry.modified) : '—'}</dd>
    {#if entry.file_id !== null}
      <dt>添付の ID</dt>
      <dd class="file-properties-path">{entry.file_id}</dd>
      <dt>投稿されたメッセージ</dt>
      <dd class="file-properties-path">{entry.message_id ?? 'まだ投稿されていません'}</dd>
    {/if}
  </dl>
</Modal>

<style>
  .file-properties {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--space-3) var(--space-4);
    margin: 0;
    font-size: var(--fs-sm);
  }
  .file-properties dt {
    color: var(--text-muted);
  }
  .file-properties dd {
    margin: 0;
    min-width: 0;
  }
  .file-properties-path {
    overflow-wrap: anywhere;
  }
</style>
