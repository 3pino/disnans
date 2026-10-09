<script lang="ts">
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import AppIcon from './AppIcon.svelte';
  import { api } from '../lib/api';
  import { normalizeServerUrl, setServerUrl } from '../lib/config';

  let { ondone }: { ondone: () => void } = $props();

  let url = $state('');
  let checking = $state(false);
  let error = $state<string | null>(null);
  let failedOnce = $state(false);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    const u = normalizeServerUrl(url);
    if (!u) return;
    checking = true;
    error = null;
    try {
      const me = await api.probe(u);
      setServerUrl(u);
      void me;
      ondone();
    } catch (err) {
      failedOnce = true;
      error = err instanceof Error ? err.message : String(err);
    } finally {
      checking = false;
    }
  }

  function saveAnyway() {
    const u = normalizeServerUrl(url);
    if (!u) return;
    setServerUrl(u);
    ondone();
  }
</script>

<div class="setup">
  <form class="card" onsubmit={submit}>
    <div class="logo"><AppIcon size={40} /></div>
    <h1>disnans へようこそ</h1>
    <p class="muted">
      接続するサーバーのアドレスを入力してください。Tailscale の IP アドレスか MagicDNS の名前が使えます。
    </p>
    <label for="server">サーバー</label>
    <input
      id="server"
      class="input"
      bind:value={url}
      placeholder="http://homeserver:8080"
      autocapitalize="off"
      autocorrect="off"
      spellcheck="false"
      inputmode="url"
      required
    />
    {#if error}
      <p class="err">接続できませんでした: {error}<br />Tailscale に接続しているか確かめてください。</p>
    {/if}
    <button class="btn primary" disabled={checking || !url.trim()}>
      {#if checking}<LoaderCircle size={16} class="spin" />{/if}
      接続する
    </button>
    {#if failedOnce}
      <button type="button" class="btn ghost" onclick={saveAnyway}>確認せずに保存</button>
    {/if}
  </form>
</div>

<style>
  .setup {
    display: grid;
    place-items: center;
    min-height: 100%;
    padding: 24px 16px;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: min(400px, 100%);
    padding: 28px 24px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    box-shadow: var(--shadow);
  }
  .logo {
    color: var(--accent);
  }
  h1 {
    margin: 4px 0 0;
    font-size: 20px;
  }
  p {
    margin: 0 0 6px;
    font-size: 14px;
  }
  label {
    font-size: 12px;
    font-weight: 700;
    color: var(--text-muted);
  }
  .err {
    color: var(--danger);
    font-size: 13px;
  }
  .btn {
    height: 42px;
    margin-top: 6px;
  }
  .ghost {
    background: transparent;
    margin-top: 0;
  }
</style>
