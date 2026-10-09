<script lang="ts">
  import type { Component, Snippet } from 'svelte';

  // メニューの1項目。見た目はグローバルの .menu-item（app.css）
  let {
    icon,
    iconSize = 18,
    danger = false,
    class: className = '',
    onclick,
    children,
  }: {
    icon?: Component<{ size?: number }>;
    iconSize?: number;
    danger?: boolean;
    class?: string;
    onclick?: (e: MouseEvent) => void;
    children?: Snippet;
  } = $props();
</script>

<button type="button" class="menu-item {className}" class:menu-item-danger={danger} role="menuitem" {onclick}>
  {#if icon}
    {@const Icon = icon}
    <Icon size={iconSize} />
  {/if}
  {@render children?.()}
</button>
