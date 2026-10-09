<script lang="ts">
  import type { Snippet } from 'svelte';

  // ポップアップのメニュー。見た目はグローバルの .menu（app.css）、位置は class で使う側が決める。
  // onclose を渡すと、外側を押したら閉じる透明な幕を出す
  let {
    label,
    class: className = '',
    onclose,
    children,
  }: {
    label?: string;
    class?: string;
    onclose?: () => void;
    children?: Snippet;
  } = $props();
</script>

{#if onclose}
  <button type="button" class="menu-backdrop" aria-label="閉じる" onclick={onclose}></button>
{/if}
<div class="menu {className}" role="menu" aria-label={label}>
  {@render children?.()}
</div>
