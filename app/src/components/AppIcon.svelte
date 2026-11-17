<script lang="ts">
  import '../lib/icons.svelte';
  import Icon from '@3pino/ui-kit-web/Icon.svelte';

  // アプリのロゴ（icon.svg と同じ形）。中身はアイコンの登録簿の disnans-logo。stroke は currentColor なので文字色で着色される
  let { size = 24 }: { size?: number } = $props();
</script>

<Icon icon="disnans-logo" {size} />
