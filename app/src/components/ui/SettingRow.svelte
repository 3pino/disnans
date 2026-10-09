<script lang="ts">
  import type { Snippet } from 'svelte';

  // 設定の1行。左に名前と説明、右に操作（control）を置く。
  // 見た目はグローバルの .setting-row（app.css）。プラグイン向けの ui.setting も同じ DOM を作る
  let {
    name,
    description,
    class: className = '',
    control,
  }: {
    name: string;
    description?: string;
    class?: string;
    control?: Snippet;
  } = $props();
</script>

<div class="setting-row {className}">
  <div class="setting-row-info">
    <div class="setting-row-name">{name}</div>
    {#if description}<div class="setting-row-description">{description}</div>{/if}
  </div>
  {#if control}
    <div class="setting-row-control">{@render control()}</div>
  {/if}
</div>
