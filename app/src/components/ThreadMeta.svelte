<script lang="ts">
  import Pencil from '@lucide/svelte/icons/pencil';
  import Archive from '@lucide/svelte/icons/archive';
  import ThreadEditDialog from './ThreadEditDialog.svelte';
  import TagChip from './TagChip.svelte';
  import IconButton from './ui/IconButton.svelte';
  import type { Message } from '../lib/protocol/Message';

  // スレッドのパネルの上に出す、タイトル・タグ・アーカイブの表示と、編集ボタン
  let { root }: { root: Message } = $props();

  const info = $derived(root.thread);
  let editing = $state(false);
</script>

{#if info}
  <div class="thread-meta">
    <div class="thread-meta-main">
      {#if info.title}<div class="thread-meta-title">{info.title}</div>{/if}
      {#if info.archived || info.tags.length > 0}
        <div class="thread-meta-tags">
          {#if info.archived}<span class="thread-meta-archived"><Archive size={12} />アーカイブ済み</span>{/if}
          {#each info.tags as tag (tag.label + '/' + (tag.icon ?? ''))}<TagChip {tag} />{/each}
        </div>
      {/if}
    </div>
    <IconButton label="タイトル・タグを編集" title="タイトル・タグを編集" onclick={() => (editing = true)}><Pencil size={15} /></IconButton>
  </div>
  {#if editing}
    <ThreadEditDialog {root} onclose={() => (editing = false)} />
  {/if}
{/if}

<style>
  .thread-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px 6px 16px;
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .thread-meta-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .thread-meta-main:empty {
    min-height: 0;
  }
  .thread-meta-title {
    font-weight: 650;
    overflow-wrap: anywhere;
  }
  .thread-meta-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .thread-meta-archived {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    color: var(--text-muted);
    font-size: 11px;
  }
  .thread-meta > :global(.icon-btn) {
    margin-left: auto;
    width: 30px;
    height: 30px;
    flex: none;
  }
  @media (max-width: 767px) {
    .thread-meta {
      padding-left: 12px;
    }
  }
</style>
