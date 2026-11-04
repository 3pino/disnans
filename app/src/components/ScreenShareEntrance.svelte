<script lang="ts">
  import Eye from '@lucide/svelte/icons/eye';
  import IconButton from './ui/IconButton.svelte';
  import type { ScreenShareView } from '../lib/call/screen/view';

  // 通話のバー（上の枠）の入口。誰かが共有を始めたら出し、押すと全画面の表示を開く（見ている間は出さない）
  let { screen, nameOf }: { screen: ScreenShareView; nameOf: (userId: string) => string } = $props();

  const first = $derived(screen.sharers[0] ?? null);
  const label = $derived.by(() => {
    if (!first) return '';
    const who = nameOf(first.userId);
    const what = first.source === 'camera' ? 'のカメラ' : 'の画面';
    return screen.sharers.length > 1 ? `${who}${what}ほか（見る）` : `${who}${what}を見る`;
  });
</script>

{#if first && !screen.viewerOpen}
  <IconButton label={label} title={label} icon={Eye} onclick={() => screen.openViewer(first.peer)} />
{/if}
