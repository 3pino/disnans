<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  import type { IconRef } from '../../lib/icons.svelte';

  // メニューの1項目。見た目はグローバルの .menu-item（app.css）
  let {
    icon,
    iconSize = 18,
    danger = false,
    class: className = '',
    onclick,
    children,
  }: {
    /** アイコン（名前か Svelte の部品） */
    icon?: IconRef;
    iconSize?: number;
    danger?: boolean;
    class?: string;
    onclick?: (e: MouseEvent) => void;
    children?: Snippet;
  } = $props();
</script>

<button type="button" class="menu-item {className}" class:menu-item-danger={danger} role="menuitem" {onclick}>
  {#if icon}<Icon {icon} size={iconSize} />{/if}
  {@render children?.()}
</button>
