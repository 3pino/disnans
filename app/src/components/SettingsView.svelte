<script lang="ts">
  import { onMount, tick } from 'svelte';
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
  import Camera from '@lucide/svelte/icons/camera';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Check from '@lucide/svelte/icons/check';
  import X from '@lucide/svelte/icons/x';
  import ImageUp from '@lucide/svelte/icons/image-up';
  import Undo2 from '@lucide/svelte/icons/undo-2';
  import Settings from '@lucide/svelte/icons/settings';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import Avatar from './Avatar.svelte';
  import Markdown from './Markdown.svelte';
  import Button from './ui/Button.svelte';
  import IconButton from './ui/IconButton.svelte';
  import Menu from './ui/Menu.svelte';
  import MenuItem from './ui/MenuItem.svelte';
  import TextInput from './ui/TextInput.svelte';
  import Section from './ui/Section.svelte';
  import SettingRow from './ui/SettingRow.svelte';
  import StatusLine from './ui/StatusLine.svelte';
  import Toggle from './ui/Toggle.svelte';
  import SegmentedButton from './ui/SegmentedButton.svelte';
  import PluginSettings from './PluginSettings.svelte';
  import ThemeSettings from './ThemeSettings.svelte';
  import EnterKeySettings from './EnterKeySettings.svelte';
  import HotkeySettings from './HotkeySettings.svelte';
  import ComposerMenuSettings from './ComposerMenuSettings.svelte';
  import CallSettings from './CallSettings.svelte';
  import DeviceKindSettings from './DeviceKindSettings.svelte';
  import { client } from '../lib/stores/client.svelte';
  import { prefs } from '../lib/stores/prefs.svelte';
  import type { MessageLayout } from '../lib/messageLayout';
  import { ui, type SettingsSubpage, type ThemePref } from '../lib/stores/ui.svelte';
  import { updater } from '../lib/stores/updater.svelte';
  import { devUser, getServerUrl, isAndroid, isCustomAvatar, isTauri, setServerUrl } from '../lib/config';
  import { notifications } from '../lib/stores/notifications.svelte';

  // 表示名は、カードの名前を押したときだけその場で編集する
  let editingName = $state(false);
  let name = $state('');
  let saving = $state(false);
  let error = $state<string | null>(null);

  // アバター
  let avatarInput = $state<HTMLInputElement>();
  let avatarMenuOpen = $state(false);
  let avatarBusy = $state(false);

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

  // 「操作」の行。押すと、その設定のサブページを開く（ショートカットはデスクトップだけ）
  const operations: { value: SettingsSubpage; name: string }[] = [
    { value: 'enterKeys', name: '入力欄のキー' },
    ...(isAndroid() ? [] : [{ value: 'hotkeys' as const, name: 'ホットキー' }]),
    { value: 'composerMenu', name: '＋メニュー' },
    { value: 'call', name: '通話' },
  ];

  const themes: { value: ThemePref; label: string; icon: typeof Sun }[] = [
    { value: 'system', label: '自動', icon: Monitor },
    { value: 'light', label: 'ライト', icon: Sun },
    { value: 'dark', label: 'ダーク', icon: Moon },
  ];

  // メッセージの表示。既定はリスト（Slack 風）
  const messageLayouts: { value: MessageLayout; label: string }[] = [
    { value: 'list', label: 'リスト' },
    { value: 'bubble', label: '吹き出し' },
  ];

  const perm = $derived(notifications.permission);
  const android = $derived(notifications.android);

  const changed = $derived(name.trim() !== '' && name.trim() !== client.me?.display_name);
  const st = $derived(updater.state);
  const busy = $derived(st.kind === 'checking' || st.kind === 'downloading' || st.kind === 'installing');

  /** 手動で確認したときだけ、「最新です」をトーストで知らせる */
  let checkingByHand = false;
  function checkUpdate() {
    checkingByHand = true;
    void updater.check();
  }
  $effect(() => {
    if (st.kind === 'latest' && checkingByHand) {
      checkingByHand = false;
      ui.toast('最新です');
    }
  });

  async function startEditName() {
    name = client.me?.display_name ?? '';
    error = null;
    editingName = true;
    await tick();
    const input = document.getElementById('settings-display-name-input') as HTMLInputElement | null;
    input?.focus();
    input?.select();
  }

  function cancelEditName() {
    editingName = false;
    error = null;
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (saving) return;
    // 変えていなければ、そのまま閉じる
    if (!changed) {
      if (name.trim() === client.me?.display_name) cancelEditName();
      return;
    }
    saving = true;
    error = null;
    try {
      await client.updateDisplayName(name.trim());
      editingName = false;
      ui.toast('表示名を変更しました');
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
    }
  }

  function onNameKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelEditName();
    }
  }

  // 自分で設定した画像なら、選び直すか Tailscale の画像に戻すかをメニューで選ぶ。そうでなければすぐ画像を選ぶ
  function onAvatarClick() {
    if (avatarBusy) return;
    if (isCustomAvatar(client.me?.avatar_url)) avatarMenuOpen = true;
    else avatarInput?.click();
  }

  function pickAvatar() {
    avatarMenuOpen = false;
    avatarInput?.click();
  }

  async function onAvatarPicked(e: Event & { currentTarget: HTMLInputElement }) {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    avatarBusy = true;
    try {
      await client.setAvatar(file);
      ui.toast('アバターを変更しました');
    } catch (err) {
      ui.toast(`アバターを変更できませんでした: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      avatarBusy = false;
    }
  }

  async function revertAvatar() {
    avatarMenuOpen = false;
    avatarBusy = true;
    try {
      await client.clearAvatar();
      ui.toast('Tailscale の画像に戻しました');
    } catch (err) {
      ui.toast(`アバターを戻せませんでした: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      avatarBusy = false;
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
  <!-- 「操作」のサブページ。一覧の上に重ねる（一覧はそのままにして、戻ったときに元の位置へ戻す） -->
  {#if ui.settingsSub}
    <div id="settings-sub-page" class="settings-sub-page" data-sub={ui.settingsSub}>
      <header class="top-bar"></header>
      <div class="settings-sub-page-header">
        <IconButton class="settings-sub-page-back" label="戻る" onclick={() => ui.closeSettingsSub()}><ArrowLeft size={20} /></IconButton>
      </div>
      <div class="scroll settings-sub-page-body">
        <div class="settings-sub-page-content">
          {#if ui.settingsSub === 'enterKeys'}
            <EnterKeySettings />
          {:else if ui.settingsSub === 'hotkeys'}
            <HotkeySettings />
          {:else if ui.settingsSub === 'call'}
            <CallSettings />
          {:else}
            <ComposerMenuSettings />
          {/if}
        </div>
      </div>
    </div>
  {/if}

  <header class="top-bar"></header>

  <div class="scroll settings-body" inert={!!ui.settingsSub}>
    <div class="settings-content">
      <Section title="プロフィール" class="settings-profile">
        <div class="settings-profile-card">
          {#if client.me}
            <div class="settings-profile-avatar-wrap">
              <button
                type="button"
                id="settings-profile-avatar"
                class="settings-profile-avatar"
                class:settings-profile-avatar-busy={avatarBusy}
                aria-label="アバターを変更"
                title="アバターを変更"
                aria-busy={avatarBusy}
                onclick={onAvatarClick}
              >
                <Avatar user={client.me} id={client.me.id} size={44} />
                <span class="settings-profile-avatar-badge" aria-hidden="true"><Camera size={12} /></span>
              </button>
              {#if avatarMenuOpen}
                <Menu class="settings-avatar-menu" label="アバター" onclose={() => (avatarMenuOpen = false)}>
                  <MenuItem class="settings-avatar-menu-pick" icon={ImageUp} onclick={pickAvatar}>画像を選ぶ</MenuItem>
                  <MenuItem class="settings-avatar-menu-revert" icon={Undo2} onclick={() => void revertAvatar()}>Tailscale の画像に戻す</MenuItem>
                </Menu>
              {/if}
              <input bind:this={avatarInput} id="settings-avatar-input" type="file" accept="image/*" hidden onchange={onAvatarPicked} />
            </div>
            <div class="settings-profile-text">
              {#if editingName}
                <form id="settings-display-name-form" class="settings-display-name-form" onsubmit={save}>
                  <TextInput
                    id="settings-display-name-input"
                    class="settings-display-name-input"
                    bind:value={name}
                    maxlength={32}
                    autocomplete="nickname"
                    aria-label="表示名"
                    enterkeyhint="done"
                    onkeydown={onNameKeydown}
                  />
                  <IconButton type="submit" label="保存" class="settings-display-name-save" disabled={saving}><Check size={18} /></IconButton>
                  <IconButton label="キャンセル" class="settings-display-name-cancel" onclick={cancelEditName}><X size={18} /></IconButton>
                </form>
                {#if error}<p class="settings-display-name-error">{error}</p>{/if}
              {:else}
                <button type="button" id="settings-profile-display-name" class="settings-profile-display-name" title="表示名を変更" onclick={() => void startEditName()}>
                  <span class="settings-profile-display-name-text">{client.me.display_name}</span>
                  <Pencil size={13} class="settings-profile-display-name-icon" />
                </button>
              {/if}
              <div class="muted settings-small-text settings-profile-login-name">{client.me.login_name}</div>
            </div>
          {/if}
          <!-- この端末の種類は、プロフィールのカードの右に並べる -->
          <DeviceKindSettings />
        </div>
      </Section>

      <Section title="外観" class="settings-appearance">
        <span class="field-label">テーマ</span>
        <SegmentedButton class="settings-theme-picker" label="テーマ" options={themes} value={ui.theme} onchange={(v) => ui.setTheme(v)} />
        <ThemeSettings />
        {#if isTauri() && isAndroid()}
          <SettingRow name="ナビゲーションバーを隠す" description="画面の下端からスワイプすると一時的に表示します" class="settings-hide-nav-bar-row">
            {#snippet control()}
              <Toggle checked={ui.hideNavigationBar} label="ナビゲーションバーを隠す" onchange={(on) => ui.setHideNavigationBar(on)} />
            {/snippet}
          </SettingRow>
        {/if}
      </Section>

      <Section title="メッセージの表示" class="settings-message-layout">
        <SegmentedButton
          class="settings-message-layout-picker"
          label="メッセージの表示"
          options={messageLayouts}
          value={prefs.messageLayout}
          onchange={(v) => prefs.setMessageLayout(v)}
        />
      </Section>

      <Section title="操作" class="settings-operations">
        {#each operations as op (op.value)}
          <!-- 行全体がボタン。右のアイコンは飾り（読み上げは行の名前） -->
          <SettingRow name={op.name} class="settings-operation-row" onclick={() => ui.openSettingsSub(op.value)}>
            {#snippet control()}
              <span class="settings-operation-icon" aria-hidden="true"><Settings size={18} /></span>
            {/snippet}
          </SettingRow>
        {/each}
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
            <div class="settings-version-control">
              <span class="settings-version">{updater.supported ? (updater.version ? `v${updater.version}` : '…') : '開発版'}</span>
              {#if updater.supported}
                <IconButton
                  class="settings-update-check"
                  label="アップデートを確認"
                  title="アップデートを確認"
                  disabled={busy}
                  onclick={checkUpdate}
                >
                  <RefreshCw size={18} class={st.kind === 'checking' ? 'spin' : ''} />
                </IconButton>
              {/if}
            </div>
          {/snippet}
        </SettingRow>

        <!-- 新しいバージョンや、うまくいかなかったときだけ、その状態の表示と操作を出す（「最新です」はトーストで知らせる） -->
        {#if updater.supported && st.kind !== 'idle' && st.kind !== 'checking' && st.kind !== 'latest'}
          <div class="settings-update">
            {#if st.kind === 'available'}
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

            {#if st.kind === 'available' || st.kind === 'permission' || st.kind === 'error'}
              <div class="settings-update-actions">
                {#if st.kind === 'available'}
                  <Button variant="primary" onclick={() => updater.install()}>
                    <Download size={15} />ダウンロードしてインストール
                  </Button>
                {:else if st.kind === 'permission'}
                  <Button variant="primary" onclick={() => updater.install()}>続ける</Button>
                {:else}
                  <Button onclick={() => updater.openReleasePage()}>
                    <ExternalLink size={15} />リリースページを開く
                  </Button>
                {/if}
              </div>
            {/if}
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
    position: relative;
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
  /* 「操作」のサブページ。一覧の上を覆う。左上に戻るボタン、中は設定と同じ幅で並べる */
  .settings-sub-page {
    position: absolute;
    inset: 0;
    z-index: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--bg);
  }
  .settings-sub-page-header {
    display: flex;
    align-items: center;
    height: 52px;
    padding: 0 16px 0 8px;
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .settings-sub-page-body {
    flex: 1;
    min-height: 0;
  }
  .settings-sub-page-content {
    max-width: 640px;
    margin: 0 auto;
    padding: 8px 16px 32px;
    display: flex;
    flex-direction: column;
    gap: 16px;
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
    flex: 1;
    min-width: 0;
  }
  /* アバターを押すと画像を選ぶ。右下にカメラの印を付ける */
  .settings-profile-avatar-wrap {
    position: relative;
    flex: none;
  }
  .settings-profile-avatar {
    position: relative;
    display: block;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: transparent;
    cursor: pointer;
  }
  .settings-profile-avatar.settings-profile-avatar-busy {
    opacity: 0.5;
    pointer-events: none;
  }
  .settings-profile-avatar-badge {
    position: absolute;
    right: -2px;
    bottom: -2px;
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--surface-2);
    border: 2px solid var(--bg);
    color: var(--text-muted);
  }
  .settings-profile-avatar-wrap > :global(.settings-avatar-menu) {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
  }
  /* 名前を押すと、その場で表示名を編集する */
  .settings-profile-display-name {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--text);
    font-weight: 700;
    font-size: 16px;
    text-align: left;
    cursor: pointer;
  }
  .settings-profile-display-name-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .settings-profile-display-name > :global(.settings-profile-display-name-icon) {
    flex: none;
    color: var(--text-muted);
  }
  .settings-display-name-form {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .settings-display-name-form > :global(.settings-display-name-input) {
    flex: 1;
    min-width: 0;
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
  .settings-display-name-error {
    color: var(--danger);
    font-size: 13px;
    margin: 6px 0 0;
  }
  /* バージョンの行は、名前を控えめな色にする */
  .settings-content :global(.settings-version-row .setting-row-name) {
    color: var(--text-muted);
  }
  .settings-version {
    font-family: var(--mono);
    font-size: 13px;
  }
  /* バージョンの右に、アップデートを確認するボタン */
  .settings-version-control {
    display: flex;
    align-items: center;
    gap: 6px;
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
  /* 「操作」の行の右の飾りのアイコン */
  .settings-operation-icon {
    display: flex;
    color: var(--text-muted);
  }
</style>
