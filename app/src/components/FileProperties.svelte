<script lang="ts">
  import Copy from '@lucide/svelte/icons/copy';
  import Search from '@lucide/svelte/icons/search';
  import Modal from './ui/Modal.svelte';
  import Button from './ui/Button.svelte';
  import { formatFull, formatSize } from '../lib/format';
  import { kindLabel } from '../lib/fileExplorer';
  import { copyText } from '../lib/clipboard';
  import { ui } from '../lib/stores/ui.svelte';
  import { messageSearch } from '../lib/stores/search.svelte';
  import type { SharedEntry } from '../lib/protocol/SharedEntry';

  // 項目のプロパティ（読むだけ）。作成日時はサーバーが持たないので出さない（更新日時だけ）。
  // 名前とパスは押すとコピーする。ファイルは「メッセージを検索」で、このファイルの名前でメッセージを探せる
  // （リンクしたファイルは、今の名前で検索に当たる）。見た目は仮
  let { entry, onclose }: { entry: SharedEntry; onclose: () => void } = $props();
  const isFile = $derived(entry.kind === 'file');

  async function copy(text: string, what: string): Promise<void> {
    if (await copyText(text)) ui.toast(`${what}をコピーしました`);
    else ui.toast(`${what}をコピーできませんでした`, 'error');
  }

  function searchMessages(): void {
    onclose();
    ui.openSearch();
    messageSearch.setQuery(entry.name);
  }
</script>

<Modal title="プロパティ" {onclose} width={380}>
  <dl class="file-properties">
    <dt>名前</dt>
    <dd><button type="button" class="file-properties-copy" title="押すとコピー" onclick={() => void copy(entry.name, '名前')}>{entry.name}<Copy size={12} /></button></dd>
    <dt>パス</dt>
    <dd><button type="button" class="file-properties-copy file-properties-path" title="押すとコピー" onclick={() => void copy(entry.path, 'パス')}>{entry.path}<Copy size={12} /></button></dd>
    <dt>種類</dt>
    <dd>{kindLabel(entry)}{#if entry.mime} <span class="muted">（{entry.mime}）</span>{/if}</dd>
    <dt>サイズ</dt>
    <dd>{isFile ? `${formatSize(entry.size)}（${entry.size.toLocaleString('ja-JP')} バイト）` : 'フォルダ'}</dd>
    <dt>更新日時</dt>
    <dd>{entry.modified > 0 ? formatFull(entry.modified) : '—'}</dd>
  </dl>
  {#if isFile}
    <div class="modal-actions">
      <Button icon={Search} onclick={searchMessages}>メッセージを検索</Button>
    </div>
  {/if}
</Modal>

<style>
  .file-properties {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--space-3) var(--space-4);
    margin: 0;
    font-size: var(--fs-sm);
  }
  /* 見出し（名前・パスなど）は選べない */
  .file-properties dt {
    color: var(--text-muted);
    user-select: none;
    -webkit-user-select: none;
  }
  .file-properties dd {
    margin: 0;
    min-width: 0;
  }
  /* 押すとコピーする値（見た目は文字のまま。コピーの印を小さく添える） */
  .file-properties-copy {
    display: inline;
    padding: 0;
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: copy;
    overflow-wrap: anywhere;
  }
  .file-properties-copy > :global(svg) {
    margin-left: var(--space-2);
    vertical-align: -1px;
    color: var(--text-muted);
  }
  .file-properties-path {
    overflow-wrap: anywhere;
  }
</style>
