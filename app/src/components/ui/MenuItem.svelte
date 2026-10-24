<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  import type { IconRef } from '../../lib/icons.svelte';

  // メニューの1項目。見た目はグローバルの .menu-item（@3pino/design-system の components.css）
  let {
    icon,
    iconSize = 18,
    danger = false,
    disabled = false,
    reason,
    class: className = '',
    onclick,
    children,
  }: {
    /** アイコン（名前か Svelte の部品） */
    icon?: IconRef;
    iconSize?: number;
    danger?: boolean;
    /** 押せない（グレーになる）。reason は項目名の下に小さく常に出す（Android など、ホバーのない画面でも見える） */
    disabled?: boolean;
    /** 押せないときの理由（無効のときだけ出す） */
    reason?: string;
    class?: string;
    onclick?: (e: MouseEvent) => void;
    children?: Snippet;
  } = $props();
</script>

<button
  type="button"
  class="menu-item {className}"
  class:menu-item-danger={danger}
  role="menuitem"
  {disabled}
  aria-disabled={disabled || undefined}
  title={disabled ? reason : undefined}
  {onclick}
>
  {#if icon}<Icon {icon} size={iconSize} />{/if}
  {#if disabled && reason}
    <span class="menu-item-label">
      {@render children?.()}
      <span class="menu-item-reason">{reason}</span>
    </span>
  {:else}
    {@render children?.()}
  {/if}
</button>

<style>
  /* 押せない項目: 項目名は薄く、理由は項目名の下に小さく（ダークモードでも --text-muted で読める） */
  .menu-item:disabled {
    color: var(--text-muted);
    cursor: default;
  }
  .menu-item:disabled:hover,
  .menu-item:disabled:active {
    background: transparent;
  }
  .menu-item-label {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
    flex: 1;
  }
  .menu-item-reason {
    font-size: var(--fs-xs);
    color: var(--text-muted);
    overflow-wrap: anywhere;
  }
</style>
