<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';

  // 見た目はグローバルの .btn（app.css）。ここは薄い包みにする
  let {
    variant = 'default',
    type = 'button',
    class: className = '',
    children,
    ...rest
  }: HTMLButtonAttributes & {
    variant?: 'default' | 'primary' | 'danger';
    children?: Snippet;
  } = $props();
</script>

<button {type} class="btn {className}" class:primary={variant === 'primary'} class:danger={variant === 'danger'} {...rest}>
  {@render children?.()}
</button>
