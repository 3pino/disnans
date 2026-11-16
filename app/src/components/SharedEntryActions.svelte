<script lang="ts">
  import EntryActions from '@3pino/explorer-kit/EntryActions.svelte';
  import { explorer } from '../lib/explorer/instance';
  import type { SharedEntry } from '../lib/protocol/SharedEntry';

  // 共有フォルダの項目の「…」。画面は共有の部品（@3pino/explorer-kit）
  let { entry, placement = 'overlay' }: { entry: SharedEntry; placement?: 'overlay' | 'inline' } = $props();
</script>

<EntryActions {explorer} {entry} {placement} />
