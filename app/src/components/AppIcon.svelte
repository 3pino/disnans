<script lang="ts">
  import Icon from './ui/Icon.svelte';

  // アプリのロゴ（icon.svg と同じ形）。中身はアイコンの登録簿の disnans-logo。stroke は currentColor なので文字色で着色される
  let { size = 24 }: { size?: number } = $props();
</script>

<Icon icon="disnans-logo" {size} />
