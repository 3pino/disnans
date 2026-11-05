<script lang="ts">
  import ScreenShareViewer from './ScreenShareViewer.svelte';
  import { call } from '../lib/call/instance.svelte';
  import { client } from '../lib/stores/client.svelte';
  import { viewTexts } from '../lib/viewTexts';
  import { pipApi } from '../lib/media/nativeScreen';

  // 画面共有の全画面の表示を、画面の一番上に重ねる（どのタブからでも開けるように、Shell に 1 つだけ置く）。
  // 通話の状態（call.screen）が無いあいだは何も出さない
  const nameOf = (userId: string) => client.user(userId)?.display_name || viewTexts.unknownUser;
</script>

{#if call.screen}
  <ScreenShareViewer screen={call.screen} {nameOf} pip={pipApi} myUserId={call.participants.find((p) => p.self)?.userId ?? null} />
{/if}
