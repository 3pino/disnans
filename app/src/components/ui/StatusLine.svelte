<script lang="ts">
  import type { Component, Snippet } from 'svelte';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';

  // アイコン付きの1行の状態表示。見た目はグローバルの .status-line（app.css）
  let {
    kind = 'default',
    icon,
    busy = false,
    class: className = '',
    children,
  }: {
    kind?: 'default' | 'muted' | 'ok' | 'accent' | 'warn' | 'error';
    icon?: Component<{ size?: number }>;
    /** 回るアイコンを出す（icon より優先） */
    busy?: boolean;
    class?: string;
    children?: Snippet;
  } = $props();
</script>

<p class="status-line {kind === 'default' ? '' : `status-line-${kind}`} {className}">
  {#if busy}
    <LoaderCircle size={15} class="spin" />
  {:else if icon}
    {@const Icon = icon}
    <Icon size={15} />
  {/if}
  {@render children?.()}
</p>
