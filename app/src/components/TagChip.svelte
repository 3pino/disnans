<script lang="ts">
  import type { ThreadTag } from '../lib/protocol/ThreadTag';
  import { tagIcon } from '../lib/tagIcons';

  // スレッドのタグ。文字列（絵文字を含む）と、あれば Lucide のアイコン
  let { tag, onclick }: { tag: ThreadTag; onclick?: () => void } = $props();
  const Icon = $derived(tag.icon ? tagIcon(tag.icon) : null);
</script>

{#if onclick}
  <button type="button" class="tag-chip" {onclick}>
    {#if Icon}<Icon size={12} />{/if}<span>{tag.label}</span>
  </button>
{:else}
  <span class="tag-chip">
    {#if Icon}<Icon size={12} />{/if}<span>{tag.label}</span>
  </span>
{/if}

<style>
  .tag-chip {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    max-width: 100%;
    padding: 0 7px;
    border: none;
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--text-muted);
    font-size: 11px;
    line-height: 18px;
    white-space: nowrap;
  }
  .tag-chip span {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  button.tag-chip {
    cursor: pointer;
  }
  button.tag-chip:hover {
    background: var(--hover);
    color: var(--text);
  }
</style>
