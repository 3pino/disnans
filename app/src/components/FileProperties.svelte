<script lang="ts">
  import KitFileProperties from '@3pino/explorer-kit/FileProperties.svelte';
  import { explorer } from '../lib/explorer/instance';
  import type { SharedEntry } from '../lib/protocol/SharedEntry';

  // 項目のプロパティ。画面は共有の部品（@3pino/explorer-kit）
  let { entry, onclose }: { entry: SharedEntry; onclose: () => void } = $props();
</script>

<KitFileProperties {explorer} {entry} {onclose} />
