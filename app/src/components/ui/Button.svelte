<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import Icon from './Icon.svelte';
  import type { IconRef } from '../../lib/icons.svelte';

  // 見た目はグローバルの .btn（app.css）。ここは薄い包みにする。プラグイン向けの ui.button も同じ DOM を作る。
  // icon を渡すと文字の左にアイコンを出す。中身（children）がなければアイコンだけのボタン（.btn-icon-only）で、label は必須
  let {
    variant = 'default',
    type = 'button',
    icon,
    label,
    class: className = '',
    children,
    ...rest
  }: HTMLButtonAttributes & {
    /** ghost は枠も背景もなく、ホバーで背景に色を付ける */
    variant?: 'default' | 'primary' | 'danger' | 'ghost';
    /** アイコン（名前か Svelte の部品） */
    icon?: IconRef;
    /** 読み上げ用の名前（aria-label） */
    label?: string;
    children?: Snippet;
  } = $props();
</script>

<button
  {type}
  class="btn {className}"
  class:primary={variant === 'primary'}
  class:danger={variant === 'danger'}
  class:ghost={variant === 'ghost'}
  class:btn-icon-only={!!icon && !children}
  aria-label={label}
  {...rest}
>
  {#if icon}<Icon {icon} size={children ? 15 : 18} />{/if}
  {@render children?.()}
</button>
