<script lang="ts">
  import { onMount } from 'svelte';
  import Sun from '@lucide/svelte/icons/sun';
  import Moon from '@lucide/svelte/icons/moon';
  import Monitor from '@lucide/svelte/icons/monitor';
  import Bell from '@lucide/svelte/icons/bell';
  import Server from '@lucide/svelte/icons/server';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Download from '@lucide/svelte/icons/download';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import Avatar from './Avatar.svelte';
  import Markdown from './Markdown.svelte';
  import { client } from '../lib/stores/client.svelte';
  import { ui, type ThemePref } from '../lib/stores/ui.svelte';
  import { updater } from '../lib/stores/updater.svelte';
  import { devUser, getServerUrl, isTauri, setServerUrl } from '../lib/config';
  import { notificationPermission, requestNotificationPermission } from '../lib/notify';

  // svelte-ignore state_referenced_locally
  let name = $state(client.me?.display_name ?? '');
  let saving = $state(false);
  let error = $state<string | null>(null);
  let perm = $state(notificationPermission());

  // 表示名が届く前に開いたとき
  $effect(() => {
    if (!name && client.me) name = client.me.display_name;
  });

  onMount(() => void updater.loadVersion());

  const themes: { id: ThemePref; label: string; icon: typeof Sun }[] = [
    { id: 'system', label: '自動', icon: Monitor },
    { id: 'light', label: 'ライト', icon: Sun },
    { id: 'dark', label: 'ダーク', icon: Moon },
  ];

  const changed = $derived(name.trim() !== '' && name.trim() !== client.me?.display_name);
  const st = $derived(updater.state);
  const busy = $derived(st.kind === 'checking' || st.kind === 'downloading' || st.kind === 'installing');

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (!changed) return;
    saving = true;
    error = null;
    try {
      await client.updateDisplayName(name.trim());
      ui.toast('表示名を変更しました');
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
    }
  }

  async function changeServer() {
    const ok = await ui.confirm({
      title: 'サーバーを変更しますか？',
      body: `現在: ${getServerUrl() || '（同じオリジン）'}\nアプリを再読み込みして、接続先の設定画面に戻ります。`,
      okLabel: '変更する',
    });
    if (!ok) return;
    setServerUrl(null);
    location.reload();
  }

  function mb(n: number): string {
    return (n / 1024 / 1024).toFixed(1);
  }
</script>

<div class="settings">
  <header class="top-bar"></header>

  <div class="scroll body">
    <div class="inner">
      <section>
        <h2>プロフィール</h2>
        {#if client.me}
          <div class="who">
            <Avatar user={client.me} id={client.me.id} size={44} />
            <div class="who-text">
              <div class="dn">{client.me.display_name}</div>
              <div class="muted small">{client.me.login_name}</div>
            </div>
          </div>
        {/if}
        <form onsubmit={save}>
          <label for="dn">表示名</label>
          <div class="row">
            <input id="dn" class="input" bind:value={name} maxlength="32" autocomplete="nickname" />
            <button class="btn primary" disabled={!changed || saving}>保存</button>
          </div>
          {#if error}<p class="err">{error}</p>{/if}
        </form>
      </section>

      <section>
        <h2>外観</h2>
        <span class="label">テーマ</span>
        <div class="seg" role="radiogroup" aria-label="テーマ">
          {#each themes as t (t.id)}
            <button type="button" role="radio" aria-checked={ui.theme === t.id} class:sel={ui.theme === t.id} onclick={() => ui.setTheme(t.id)}>
              <t.icon size={15} />{t.label}
            </button>
          {/each}
        </div>
      </section>

      <section>
        <h2>通知</h2>
        {#if perm === 'unsupported'}
          <p class="muted small">この環境ではシステム通知を使えません。アプリ内に表示します。</p>
        {:else if perm === 'granted'}
          <p class="muted small"><Bell size={13} /> アプリが裏にあるときは、システム通知で知らせます。</p>
        {:else if perm === 'denied'}
          <p class="muted small">通知はブロックされています。ブラウザーの設定から許可できます。</p>
        {:else}
          <p class="muted small">アプリが裏にあるときに、システム通知で知らせます。</p>
          <button type="button" class="btn" onclick={async () => (perm = await requestNotificationPermission())}>
            <Bell size={15} />通知を許可する
          </button>
        {/if}
      </section>

      {#if isTauri() || devUser}
        <section>
          <h2>接続</h2>
          <p class="muted small line">
            <Server size={13} />
            <span class="url">{getServerUrl() || '同じオリジン（開発用プロキシ）'}</span>
          </p>
          {#if devUser}<p class="muted small">開発ユーザー: {devUser}</p>{/if}
          {#if isTauri()}
            <button type="button" class="btn" onclick={changeServer}>サーバーを変更</button>
          {/if}
        </section>
      {/if}

      <section>
        <h2>アプリ</h2>
        <div class="kv">
          <span class="muted">バージョン</span>
          <span class="ver">{updater.supported ? (updater.version ? `v${updater.version}` : '…') : '開発版'}</span>
        </div>

        {#if updater.supported}
          <div class="update">
            {#if st.kind === 'latest'}
              <p class="status ok"><CircleCheck size={15} />最新です</p>
            {:else if st.kind === 'checking'}
              <p class="status muted"><LoaderCircle size={15} class="spin" />確認中…</p>
            {:else if st.kind === 'available'}
              <p class="status new">新しいバージョンがあります: v{st.version} が利用できます</p>
              {#if st.notes}
                <div class="notes scroll"><Markdown body={st.notes} /></div>
              {/if}
            {:else if st.kind === 'permission'}
              <p class="status new">インストールの許可が必要です</p>
              <p class="muted small">
                アップデートを入れるには、一度だけ「不明なアプリのインストール」で disnans を許可してください。開いた設定画面で許可したら、戻って「続ける」を押してください。
              </p>
            {:else if st.kind === 'downloading'}
              <p class="status muted">
                <LoaderCircle size={15} class="spin" />ダウンロード中…
                {#if st.total}{Math.floor((st.downloaded / st.total) * 100)}%{:else}{mb(st.downloaded)} MB{/if}
              </p>
              <progress max={st.total ?? undefined} value={st.total ? st.downloaded : undefined}></progress>
            {:else if st.kind === 'installing'}
              <p class="status muted"><LoaderCircle size={15} class="spin" />インストールしています…</p>
            {:else if st.kind === 'error'}
              <p class="status err">エラー: {st.message}</p>
              <p class="muted small">うまくいかないときは、リリースページから直接ダウンロードできます。</p>
            {/if}

            <div class="actions">
              {#if st.kind === 'available'}
                <button type="button" class="btn primary" onclick={() => updater.install()}>
                  <Download size={15} />ダウンロードしてインストール
                </button>
              {:else if st.kind === 'permission'}
                <button type="button" class="btn primary" onclick={() => updater.install()}>続ける</button>
              {:else}
                <button type="button" class="btn" disabled={busy} onclick={() => updater.check()}>
                  <RefreshCw size={15} />アップデートを確認
                </button>
              {/if}
              {#if st.kind === 'error'}
                <button type="button" class="btn" onclick={() => updater.openReleasePage()}>
                  <ExternalLink size={15} />リリースページを開く
                </button>
              {/if}
            </div>
          </div>
        {/if}
      </section>
    </div>
  </div>
</div>

<style>
  .settings {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
    min-height: 0;
  }
  .body {
    flex: 1;
    min-height: 0;
  }
  .inner {
    max-width: 640px;
    margin: 0 auto;
    padding: 8px 16px 32px;
  }
  /* カードにはせず、見出し + 区切り線だけのセクションにする */
  section {
    padding: 18px 2px;
  }
  section + section {
    border-top: 1px solid var(--border);
  }
  section:first-child {
    padding-top: 4px;
  }
  h2 {
    margin: 0 0 12px;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }
  section > :global(* + *) {
    margin-top: 10px;
  }
  .who {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 16px;
  }
  .who-text {
    min-width: 0;
  }
  .dn {
    font-weight: 700;
    font-size: 16px;
  }
  .small {
    font-size: 13px;
    margin: 0;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .url {
    overflow-wrap: anywhere;
  }
  label,
  .label {
    display: block;
    margin-bottom: 6px;
    font-size: 12px;
    font-weight: 700;
    color: var(--text-muted);
  }
  .row {
    display: flex;
    gap: 8px;
  }
  .row .btn {
    height: 40px;
  }
  .err {
    color: var(--danger);
    font-size: 13px;
    margin: 6px 0 0;
  }
  .seg {
    display: flex;
    gap: 4px;
    padding: 4px;
    background: var(--surface-2);
    border-radius: var(--radius-sm);
  }
  .seg button {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 32px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--text-muted);
    font-size: 13px;
    font-weight: 600;
  }
  .seg button.sel {
    background: var(--bg);
    color: var(--text);
  }
  .kv {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 14px;
  }
  .ver {
    font-family: var(--mono);
    font-size: 13px;
  }
  .update {
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  .update > :global(* + *) {
    margin-top: 10px;
  }
  .status {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }
  .status.ok {
    color: var(--success);
  }
  .status.new {
    color: var(--accent);
  }
  .status.err {
    color: var(--danger);
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .notes {
    max-height: 220px;
    padding: 10px 12px;
    background: var(--surface);
    border-radius: var(--radius-sm);
    font-size: 14px;
  }
  progress {
    width: 100%;
    height: 8px;
    accent-color: var(--accent);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
</style>
