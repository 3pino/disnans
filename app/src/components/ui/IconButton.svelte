<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import Icon from './Icon.svelte';
  import type { IconRef } from '../../lib/icons.svelte';

  // 見た目はグローバルの .icon-btn（app.css）。枠のない、アイコンだけのボタンなので label（aria-label）は必須。
  // アイコンは icon（名前か Svelte の部品）で渡すか、中身（children）に書く
  let {
    label,
    icon,
    iconSize = 18,
    active = false,
    class: className = '',
    children,
    ...rest
  }: HTMLButtonAttributes & {
    label: string;
    icon?: IconRef;
    iconSize?: number;
    /** 押されている状態（メニューを開いているなど） */
    active?: boolean;
    children?: Snippet;
  } = $props();
</script>

<button type="button" class="icon-btn {className}" class:active aria-label={label} {...rest}>
  {#if icon}<Icon {icon} size={iconSize} />{/if}
  {@render children?.()}
</button>
