<script lang="ts">
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import AppIcon from './AppIcon.svelte';
  import Button from './ui/Button.svelte';
  import TextInput from './ui/TextInput.svelte';
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

<div id="setup" class="setup">
  <form class="setup-card" onsubmit={submit}>
    <div class="setup-logo"><AppIcon size={40} /></div>
    <h1 class="setup-title">disnans へようこそ</h1>
    <p class="muted setup-intro">
      接続するサーバーのアドレスを入力してください。Tailscale の IP アドレスか MagicDNS の名前が使えます。
    </p>
    <label class="field-label setup-server-label" for="setup-server-url">サーバー</label>
    <TextInput
      id="setup-server-url"
      class="setup-server-input"
      bind:value={url}
      placeholder="http://homeserver:8080"
      autocapitalize="off"
      autocorrect="off"
      spellcheck="false"
      inputmode="url"
      required
    />
    {#if error}
      <p class="setup-error">接続できませんでした: {error}<br />Tailscale に接続しているか確かめてください。</p>
    {/if}
    <Button type="submit" variant="primary" class="setup-connect" disabled={checking || !url.trim()}>
      {#if checking}<LoaderCircle size={16} class="spin" />{/if}
      接続する
    </Button>
    {#if failedOnce}
      <Button class="setup-save-anyway" onclick={saveAnyway}>確認せずに保存</Button>
    {/if}
  </form>
</div>

<style>
  .setup {
    display: grid;
    place-items: center;
    min-height: 100%;
    padding: calc(env(safe-area-inset-top) + 24px) 16px calc(env(safe-area-inset-bottom) + 24px);
  }
  .setup-card {
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
  .setup-logo {
    color: var(--accent);
  }
  .setup-title {
    margin: 4px 0 0;
    font-size: 20px;
  }
  .setup-intro,
  .setup-error {
    margin: 0 0 6px;
    font-size: 14px;
  }
  /* フォームの縦の間隔は gap で取るので、見出しの下の余白はなくす */
  .setup-server-label {
    margin-bottom: 0;
  }
  .setup-error {
    color: var(--danger);
    font-size: 13px;
  }
  .setup-card > :global(.btn) {
    height: 42px;
    margin-top: 6px;
  }
  .setup-card > :global(.setup-save-anyway) {
    background: transparent;
    margin-top: 0;
  }
</style>
