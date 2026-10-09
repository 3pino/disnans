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
  import Avatar from './Avatar.svelte';
  import Markdown from './Markdown.svelte';
  import Button from './ui/Button.svelte';
  import TextInput from './ui/TextInput.svelte';
  import Section from './ui/Section.svelte';
  import SettingRow from './ui/SettingRow.svelte';
  import StatusLine from './ui/StatusLine.svelte';
  import PluginSettings from './PluginSettings.svelte';
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
      <Section title="プロフィール" class="settings-profile">
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
          <label class="field-label" for="settings-display-name-input">表示名</label>
          <div class="settings-display-name-row">
            <TextInput id="settings-display-name-input" class="settings-display-name-input" bind:value={name} maxlength={32} autocomplete="nickname" />
            <Button type="submit" variant="primary" class="settings-display-name-save" disabled={!changed || saving}>保存</Button>
          </div>
          {#if error}<p class="settings-display-name-error">{error}</p>{/if}
        </form>
      </Section>

      <Section title="外観" class="settings-appearance">
        <span class="field-label">テーマ</span>
        <div class="settings-theme-picker" role="radiogroup" aria-label="テーマ">
          {#each themes as t (t.id)}
            <button type="button" class="settings-theme-option" role="radio" aria-checked={ui.theme === t.id} class:settings-theme-option-selected={ui.theme === t.id} onclick={() => ui.setTheme(t.id)}>
              <t.icon size={15} />{t.label}
            </button>
          {/each}
        </div>
      </Section>

      <Section title="通知" class="settings-notifications">
        {#if notifications.backend === 'android'}
          {#if android && !android.permission}
            <StatusLine kind="warn" icon={BellOff}>通知が許可されていません</StatusLine>
            <Button onclick={() => notifications.requestPermission()}>
              <Bell size={15} />通知を許可する
            </Button>
          {:else if android && !android.connected}
            <StatusLine kind="muted" busy>通知用の接続を再試行しています…</StatusLine>
          {/if}
          {#if android && !android.batteryUnrestricted}
            <p class="muted settings-small-text">電池の最適化を解除すると、省電力中も接続が切れにくくなり、通知が遅れにくくなります。</p>
            <Button onclick={() => notifications.openBatterySettings()}>
              <BatteryCharging size={15} />電池の最適化を解除
            </Button>
          {/if}
        {:else if perm === 'unsupported'}
          <p class="muted settings-small-text">この環境ではシステム通知を使えません。アプリ内に表示します。</p>
        {:else if perm === 'denied'}
          <p class="muted settings-small-text">通知はブロックされています。{isTauri() ? 'OS' : 'ブラウザー'}の設定から許可できます。</p>
        {:else if perm === 'default'}
          <Button onclick={() => notifications.requestPermission()}>
            <Bell size={15} />通知を許可する
          </Button>
        {/if}
        <Button disabled={notifications.sendingSample} onclick={() => notifications.sendSample()}>
          <Send size={15} />サンプル通知を送信
        </Button>
      </Section>

      <PluginSettings />

      {#if isTauri() || devUser}
        <Section title="接続" class="settings-connection">
          <p class="muted settings-small-text settings-server-line">
            <Server size={13} />
            <span class="settings-server-url">{getServerUrl() || '同じオリジン（開発用プロキシ）'}</span>
          </p>
          {#if devUser}<p class="muted settings-small-text">開発ユーザー: {devUser}</p>{/if}
          {#if isTauri()}
            <Button class="settings-change-server" onclick={changeServer}>サーバーを変更</Button>
          {/if}
        </Section>
      {/if}

      <Section title="アプリ" class="settings-app">
        <SettingRow name="バージョン" class="settings-version-row">
          {#snippet control()}
            <span class="settings-version">{updater.supported ? (updater.version ? `v${updater.version}` : '…') : '開発版'}</span>
          {/snippet}
        </SettingRow>

        {#if updater.supported}
          <div class="settings-update">
            {#if st.kind === 'latest'}
              <StatusLine kind="ok" icon={CircleCheck}>最新です</StatusLine>
            {:else if st.kind === 'checking'}
              <StatusLine kind="muted" busy>確認中…</StatusLine>
            {:else if st.kind === 'available'}
              <StatusLine kind="accent">新しいバージョンがあります: v{st.version} が利用できます</StatusLine>
              {#if st.notes}
                <div class="settings-update-notes scroll"><Markdown body={st.notes} /></div>
              {/if}
            {:else if st.kind === 'permission'}
              <StatusLine kind="accent">インストールの許可が必要です</StatusLine>
              <p class="muted settings-small-text">
                アップデートを入れるには、一度だけ「不明なアプリのインストール」で disnans を許可してください。開いた設定画面で許可したら、戻って「続ける」を押してください。
              </p>
            {:else if st.kind === 'downloading'}
              <StatusLine kind="muted" busy>
                ダウンロード中…
                {#if st.total}{Math.floor((st.downloaded / st.total) * 100)}%{:else}{mb(st.downloaded)} MB{/if}
              </StatusLine>
              <progress class="settings-update-progress" max={st.total ?? undefined} value={st.total ? st.downloaded : undefined}></progress>
            {:else if st.kind === 'installing'}
              <StatusLine kind="muted" busy>インストールしています…</StatusLine>
            {:else if st.kind === 'error'}
              <StatusLine kind="error">エラー: {st.message}</StatusLine>
              <p class="muted settings-small-text">うまくいかないときは、リリースページから直接ダウンロードできます。</p>
            {/if}

            <div class="settings-update-actions">
              {#if st.kind === 'available'}
                <Button variant="primary" onclick={() => updater.install()}>
                  <Download size={15} />ダウンロードしてインストール
                </Button>
              {:else if st.kind === 'permission'}
                <Button variant="primary" onclick={() => updater.install()}>続ける</Button>
              {:else}
                <Button disabled={busy} onclick={() => updater.check()}>
                  <RefreshCw size={15} />アップデートを確認
                </Button>
              {/if}
              {#if st.kind === 'error'}
                <Button onclick={() => updater.openReleasePage()}>
                  <ExternalLink size={15} />リリースページを開く
                </Button>
              {/if}
            </div>
          </div>
        {/if}
      </Section>
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
  .settings-display-name-row {
    display: flex;
    gap: 8px;
  }
  .settings-display-name-row > :global(.btn) {
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
  /* バージョンの行は、名前を控えめな色にする */
  .settings-content :global(.settings-version-row .setting-row-name) {
    color: var(--text-muted);
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
