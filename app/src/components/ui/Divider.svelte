<script lang="ts">
  // 横の区切り線。見た目はグローバルの .divider（@3pino/design-system の components.css）。プラグイン向けの ui.divider も同じ DOM を作る
  let { class: className = '' }: { class?: string } = $props();
</script>

<hr class="divider {className}" />
