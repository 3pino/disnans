<script lang="ts">
  import type { Snippet } from 'svelte';

  // 設定画面のセクション（見出し + 区切り線）。見た目はグローバルの .setting-section（app.css）
  let { title, class: className = '', children }: { title: string; class?: string; children?: Snippet } = $props();
</script>

<section class="setting-section {className}">
  <h2 class="setting-section-title">{title}</h2>
  {@render children?.()}
</section>
