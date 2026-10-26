<script lang="ts">
  import WifiOff from '@lucide/svelte/icons/wifi-off';
  import { client } from '../lib/stores/client.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { BANNER_SHOW_MS, BANNER_STALL_MS, CONNECTION_HINT, bannerPhase } from '../lib/connection';

  // 切れている時間を、最初に切れた時点から数える（再接続を繰り返しても、ここはリセットしない）。
  // 一瞬の切れはちらつかないよう出さない・少し続いたら出す・長く続いたら原因と接続設定を出す
  let phase = $state<'hidden' | 'short' | 'stalled'>('hidden');
  let downSince: number | null = null;
  $effect(() => {
    if (client.status === 'open') {
      downSince = null;
      phase = 'hidden';
      return;
    }
    const since = (downSince ??= Date.now());
    const elapsed = Date.now() - since;
    phase = bannerPhase(elapsed);
    const timers = [BANNER_SHOW_MS, BANNER_STALL_MS]
      .filter((at) => at > elapsed)
      .map((at) => setTimeout(() => (phase = bannerPhase(Date.now() - since)), at - elapsed));
    return () => timers.forEach((t) => clearTimeout(t));
  });

  const detailed = $derived(client.chatDown || phase === 'stalled');
</script>

{#if phase !== 'hidden'}
  <div class="connection-banner" role="status">
    <WifiOff size={15} />
    <span class="connection-banner-text"
      >{client.chatDown
        ? 'チャットに接続できません。30秒ごとに再試行しています'
        : phase === 'stalled'
          ? CONNECTION_HINT
          : client.ready
            ? 'サーバーとの接続が切れました。再接続しています…'
            : 'サーバーに接続しています…'}</span
    >
    {#if detailed && client.linkReason}
      <span class="connection-banner-reason">原因: {client.linkReason}</span>
    {/if}
    <button type="button" class="connection-banner-reconnect" onclick={() => client.reconnect()}>今すぐ再接続</button>
    {#if detailed}
      <button type="button" class="connection-banner-reconnect" onclick={() => ui.openSettings()}>接続設定</button>
    {/if}
  </div>
{/if}

<style>
  .connection-banner {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-7);
    background: color-mix(in oklch, var(--warning) 16%, var(--bg));
    color: var(--warning);
    font-size: var(--fs-sm);
    font-weight: var(--fw-medium);
    border-bottom: 1px solid color-mix(in oklch, var(--warning) 40%, transparent);
  }
  .connection-banner-reason {
    color: var(--text-muted);
    font-size: var(--fs-xs);
    overflow-wrap: anywhere;
  }
  .connection-banner-reconnect {
    margin-left: auto;
    border: none;
    background: none;
    color: inherit;
    text-decoration: underline;
    font-size: var(--fs-sm);
  }
</style>
