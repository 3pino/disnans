<script lang="ts">
  import type { Snippet } from 'svelte';
  import Divider from './Divider.svelte';

  // 設定画面のセクション（区切り線 + 見出し）。見た目はグローバルの .setting-section（app.css）。
  // 区切り線（Divider）は、前にもセクションがあるときだけ出る
  let { title, class: className = '', children }: { title: string; class?: string; children?: Snippet } = $props();
</script>

<section class="setting-section {className}">
  <Divider class="setting-section-divider" />
  <h2 class="setting-section-title">{title}</h2>
  {@render children?.()}
</section>
