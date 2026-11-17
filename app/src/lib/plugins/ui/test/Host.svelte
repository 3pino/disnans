<script lang="ts">
  import { onMount } from 'svelte';

  // 試験用: onMount（Svelte の効果の中）で、プラグインの部品を作る
  let { make }: { make: () => void } = $props();
  onMount(() => make());
</script>
