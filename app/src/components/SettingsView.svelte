<script lang="ts">
  import { onMount } from 'svelte';
  import Sun from '@lucide/svelte/icons/sun';
  import Moon from '@lucide/svelte/icons/moon';
  import Monitor from '@lucide/svelte/icons/monitor';
  import Bell from '@lucide/svelte/icons/bell';
  import BellOff from '@lucide/svelte/icons/bell-off';
  import BatteryCharging from '@lucide/svelte/icons/battery-charging';
  import Send from '@lucide/svelte/icons/send';
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
  import { notifications } from '../lib/stores/notifications.svelte';

  // svelte-ignore state_referenced_locally
  let name = $state(client.me?.display_name ?? '');
  let saving = $state(false);
  let error = $state<string | null>(null);

  // 表示名が届く前に開いたとき
  $effect(() => {
    if (!name && client.me) name = client.me.display_name;
  });

  onMount(() => {
    void updater.loadVersion();
    if (notifications.backend !== 'android') return;
    // 接続の状態や、端末の設定画面から戻ったときの変化を反映する
    void notifications.refresh();
    const timer = setInterval(() => void notifications.refresh(), 3000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void notifications.refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  });

  const themes: { id: ThemePref; label: string; icon: typeof Sun }[] = [
    { id: 'system', label: '自動', icon: Monitor },
    { id: 'light', label: 'ライト', icon: Sun },
    { id: 'dark', label: 'ダーク', icon: Moon },
  ];

  const perm = $derived(notifications.permission);
  const android = $derived(notifications.android);

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

<div id="settings" class="settings-view">
  <header class="top-bar"></header>

  <div class="scroll settings-body">
    <div class="settings-content">
      <section class="settings-section settings-profile">
        <h2 class="settings-section-title">プロフィール</h2>
        {#if client.me}
          <div class="settings-profile-card">
            <Avatar user={client.me} id={client.me.id} size={44} />
            <div class="settings-profile-text">
              <div class="settings-profile-display-name">{client.me.display_name}</div>
              <div class="muted settings-small-text settings-profile-login-name">{client.me.login_name}</div>
            </div>
          </div>
        {/if}
        <form class="settings-display-name-form" onsubmit={save}>
          <label class="settings-field-label" for="settings-display-name-input">表示名</label>
          <div class="settings-display-name-row">
            <input id="settings-display-name-input" class="input settings-display-name-input" bind:value={name} maxlength="32" autocomplete="nickname" />
            <button class="btn primary settings-display-name-save" disabled={!changed || saving}>保存</button>
          </div>
          {#if error}<p class="settings-display-name-error">{error}</p>{/if}
        </form>
      </section>

      <section class="settings-section settings-appearance">
        <h2 class="settings-section-title">外観</h2>
        <span class="settings-field-label">テーマ</span>
        <div class="settings-theme-picker" role="radiogroup" aria-label="テーマ">
          {#each themes as t (t.id)}
            <button type="button" class="settings-theme-option" role="radio" aria-checked={ui.theme === t.id} class:settings-theme-option-selected={ui.theme === t.id} onclick={() => ui.setTheme(t.id)}>
              <t.icon size={15} />{t.label}
            </button>
          {/each}
        </div>
      </section>

      <section class="settings-section settings-notifications">
        <h2 class="settings-section-title">通知</h2>
        {#if notifications.backend === 'android'}
          {#if android && !android.permission}
            <p class="settings-status settings-status-warn"><BellOff size={15} />通知が許可されていません</p>
            <button type="button" class="btn" onclick={() => notifications.requestPermission()}>
              <Bell size={15} />通知を許可する
            </button>
          {:else if android && !android.connected}
            <p class="settings-status muted"><LoaderCircle size={15} class="spin" />通知用の接続を再試行しています…</p>
          {/if}
          {#if android && !android.batteryUnrestricted}
            <p class="muted settings-small-text">電池の最適化を解除すると、省電力中も接続が切れにくくなり、通知が遅れにくくなります。</p>
            <button type="button" class="btn" onclick={() => notifications.openBatterySettings()}>
              <BatteryCharging size={15} />電池の最適化を解除
            </button>
          {/if}
        {:else if perm === 'unsupported'}
          <p class="muted settings-small-text">この環境ではシステム通知を使えません。アプリ内に表示します。</p>
        {:else if perm === 'denied'}
          <p class="muted settings-small-text">通知はブロックされています。{isTauri() ? 'OS' : 'ブラウザー'}の設定から許可できます。</p>
        {:else if perm === 'default'}
          <button type="button" class="btn" onclick={() => notifications.requestPermission()}>
            <Bell size={15} />通知を許可する
          </button>
        {/if}
        <button type="button" class="btn" disabled={notifications.sendingSample} onclick={() => notifications.sendSample()}>
          <Send size={15} />サンプル通知を送信
        </button>
      </section>

      {#if isTauri() || devUser}
        <section class="settings-section settings-connection">
          <h2 class="settings-section-title">接続</h2>
          <p class="muted settings-small-text settings-server-line">
            <Server size={13} />
            <span class="settings-server-url">{getServerUrl() || '同じオリジン（開発用プロキシ）'}</span>
          </p>
          {#if devUser}<p class="muted settings-small-text">開発ユーザー: {devUser}</p>{/if}
          {#if isTauri()}
            <button type="button" class="btn settings-change-server" onclick={changeServer}>サーバーを変更</button>
          {/if}
        </section>
      {/if}

      <section class="settings-section settings-app">
        <h2 class="settings-section-title">アプリ</h2>
        <div class="settings-version-row">
          <span class="muted settings-version-label">バージョン</span>
          <span class="settings-version">{updater.supported ? (updater.version ? `v${updater.version}` : '…') : '開発版'}</span>
        </div>

        {#if updater.supported}
          <div class="settings-update">
            {#if st.kind === 'latest'}
              <p class="settings-status settings-status-ok"><CircleCheck size={15} />最新です</p>
            {:else if st.kind === 'checking'}
              <p class="settings-status muted"><LoaderCircle size={15} class="spin" />確認中…</p>
            {:else if st.kind === 'available'}
              <p class="settings-status settings-status-new">新しいバージョンがあります: v{st.version} が利用できます</p>
              {#if st.notes}
                <div class="settings-update-notes scroll"><Markdown body={st.notes} /></div>
              {/if}
            {:else if st.kind === 'permission'}
              <p class="settings-status settings-status-new">インストールの許可が必要です</p>
              <p class="muted settings-small-text">
                アップデートを入れるには、一度だけ「不明なアプリのインストール」で disnans を許可してください。開いた設定画面で許可したら、戻って「続ける」を押してください。
              </p>
            {:else if st.kind === 'downloading'}
              <p class="settings-status muted">
                <LoaderCircle size={15} class="spin" />ダウンロード中…
                {#if st.total}{Math.floor((st.downloaded / st.total) * 100)}%{:else}{mb(st.downloaded)} MB{/if}
              </p>
              <progress class="settings-update-progress" max={st.total ?? undefined} value={st.total ? st.downloaded : undefined}></progress>
            {:else if st.kind === 'installing'}
              <p class="settings-status muted"><LoaderCircle size={15} class="spin" />インストールしています…</p>
            {:else if st.kind === 'error'}
              <p class="settings-status settings-status-error">エラー: {st.message}</p>
              <p class="muted settings-small-text">うまくいかないときは、リリースページから直接ダウンロードできます。</p>
            {/if}

            <div class="settings-update-actions">
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
  /* 設定画面は文章ではないので、文字を選択できないようにする（入力欄は除く） */
  .settings-view {
    -webkit-user-select: none;
    user-select: none;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
    min-height: 0;
  }
  .settings-body {
    flex: 1;
    min-height: 0;
  }
  .settings-content {
    max-width: 640px;
    margin: 0 auto;
    padding: 8px 16px 32px;
  }
  /* カードにはせず、見出し + 区切り線だけのセクションにする */
  .settings-section {
    padding: 18px 2px;
  }
  .settings-section + .settings-section {
    border-top: 1px solid var(--border);
  }
  .settings-section:first-child {
    padding-top: 4px;
  }
  .settings-section-title {
    margin: 0 0 12px;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }
  .settings-section > :global(* + *) {
    margin-top: 10px;
  }
  .settings-profile-card {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 16px;
  }
  .settings-profile-text {
    min-width: 0;
  }
  .settings-profile-display-name {
    font-weight: 700;
    font-size: 16px;
  }
  .settings-small-text {
    font-size: 13px;
    margin: 0;
  }
  .settings-server-line {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .settings-server-url {
    overflow-wrap: anywhere;
  }
  .settings-field-label {
    display: block;
    margin-bottom: 6px;
    font-size: 12px;
    font-weight: 700;
    color: var(--text-muted);
  }
  .settings-display-name-row {
    display: flex;
    gap: 8px;
  }
  .settings-display-name-row .btn {
    height: 40px;
  }
  .settings-display-name-error {
    color: var(--danger);
    font-size: 13px;
    margin: 6px 0 0;
  }
  .settings-theme-picker {
    display: flex;
    gap: 4px;
    padding: 4px;
    background: var(--surface-2);
    border-radius: var(--radius-sm);
  }
  .settings-theme-picker .settings-theme-option {
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
  .settings-theme-picker .settings-theme-option.settings-theme-option-selected {
    background: var(--bg);
    color: var(--text);
  }
  .settings-version-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 14px;
  }
  .settings-version {
    font-family: var(--mono);
    font-size: 13px;
  }
  .settings-update {
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  .settings-update > :global(* + *) {
    margin-top: 10px;
  }
  .settings-status {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }
  .settings-status.settings-status-ok {
    color: var(--success);
  }
  .settings-status.settings-status-new {
    color: var(--accent);
  }
  .settings-status.settings-status-warn {
    color: var(--warning);
  }
  .settings-status.settings-status-error {
    color: var(--danger);
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .settings-update-notes {
    max-height: 220px;
    padding: 10px 12px;
    background: var(--surface);
    border-radius: var(--radius-sm);
    font-size: 14px;
  }
  .settings-update-progress {
    width: 100%;
    height: 8px;
    accent-color: var(--accent);
  }
  .settings-update-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
</style>
