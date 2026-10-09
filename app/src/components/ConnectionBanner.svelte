<script lang="ts">
  import WifiOff from '@lucide/svelte/icons/wifi-off';
  import { client } from '../lib/stores/client.svelte';

  // 一瞬の再接続ではちらつかないよう、少し待ってから出す
  let show = $state(false);
  $effect(() => {
    if (client.status === 'open') {
      show = false;
      return;
    }
    const t = setTimeout(() => (show = true), 1500);
    return () => clearTimeout(t);
  });
</script>

{#if show}
  <div class="banner" role="status">
    <WifiOff size={15} />
    <span>{client.ready ? 'サーバーとの接続が切れました。再接続しています…' : 'サーバーに接続しています…'}</span>
    <button type="button" onclick={() => client.reconnect()}>今すぐ再接続</button>
  </div>
{/if}

<style>
  .banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 16px;
    background: color-mix(in oklch, var(--warning) 16%, var(--bg));
    color: var(--warning);
    font-size: 13px;
    font-weight: 500;
    border-bottom: 1px solid color-mix(in oklch, var(--warning) 40%, transparent);
  }
  button {
    margin-left: auto;
    border: none;
    background: none;
    color: inherit;
    text-decoration: underline;
    font-size: 13px;
  }
</style>
