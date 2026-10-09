<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';

  // 見た目はグローバルの .icon-btn（app.css）。アイコンだけのボタンなので label（aria-label）は必須
  let {
    label,
    active = false,
    class: className = '',
    children,
    ...rest
  }: HTMLButtonAttributes & {
    label: string;
    /** 押されている状態（メニューを開いているなど） */
    active?: boolean;
    children?: Snippet;
  } = $props();
</script>

<button type="button" class="icon-btn {className}" class:active aria-label={label} {...rest}>
  {@render children?.()}
</button>
