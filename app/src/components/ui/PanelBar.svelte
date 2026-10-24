<script lang="ts">
  import type { Snippet } from 'svelte';

  // 全画面パネルの見出しの行（題名や場所・右の操作）。上の安全域は .top-bar（@3pino/design-system）が1か所で取る。
  // 戻るボタンは持たない（戻る操作・ナビゲーションバー・パンくずで戻る）。左の余白は本文（space-7）にそろえる
  let {
    class: className = '',
    children,
    actions,
  }: {
    class?: string;
    /** 題名や場所（残りの幅を使う） */
    children?: Snippet;
    /** 右に並べる操作 */
    actions?: Snippet;
  } = $props();
</script>

<header class="top-bar panel-bar {className}">
  <div class="panel-bar-main">{@render children?.()}</div>
  {#if actions}{@render actions()}{/if}
</header>

<style>
  .panel-bar {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    /* 上の余白は .top-bar のもの（省略形の padding で上まで消さない） */
    padding-right: var(--space-4);
    padding-bottom: var(--space-3);
    padding-left: var(--space-7);
    border-bottom: 1px solid var(--border);
  }
  .panel-bar-main {
    flex: 1;
    min-width: 0;
    min-height: 34px;
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
</style>
