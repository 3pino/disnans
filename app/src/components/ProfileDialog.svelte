<script lang="ts">
  import Sun from '@lucide/svelte/icons/sun';
  import Moon from '@lucide/svelte/icons/moon';
  import Monitor from '@lucide/svelte/icons/monitor';
  import Bell from '@lucide/svelte/icons/bell';
  import Server from '@lucide/svelte/icons/server';
  import Modal from './Modal.svelte';
  import Avatar from './Avatar.svelte';
  import { client } from '../lib/stores/client.svelte';
  import { ui, type ThemePref } from '../lib/stores/ui.svelte';
  import { devUser, getServerUrl, isTauri, setServerUrl } from '../lib/config';
  import { notificationPermission, requestNotificationPermission } from '../lib/notify';

  // svelte-ignore state_referenced_locally
  let name = $state(client.me?.display_name ?? '');
  let saving = $state(false);
  let error = $state<string | null>(null);
  let perm = $state(notificationPermission());

  const themes: { id: ThemePref; label: string; icon: typeof Sun }[] = [
    { id: 'system', label: '自動', icon: Monitor },
    { id: 'light', label: 'ライト', icon: Sun },
    { id: 'dark', label: 'ダーク', icon: Moon },
  ];

  const changed = $derived(name.trim() !== '' && name.trim() !== client.me?.display_name);

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
</script>

<Modal title="プロフィールと設定" onclose={() => (ui.profileOpen = false)}>
  {#if client.me}
    <div class="who">
      <Avatar user={client.me} id={client.me.id} size={44} />
      <div>
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

  <div class="section">
    <span class="label">テーマ</span>
    <div class="seg" role="radiogroup" aria-label="テーマ">
      {#each themes as t (t.id)}
        <button type="button" role="radio" aria-checked={ui.theme === t.id} class:sel={ui.theme === t.id} onclick={() => ui.setTheme(t.id)}>
          <t.icon size={15} />{t.label}
        </button>
      {/each}
    </div>
  </div>

  <div class="section">
    <span class="label">通知</span>
    {#if perm === 'unsupported'}
      <p class="muted small">この環境ではシステム通知を使えません。アプリ内に表示します。</p>
    {:else if perm === 'granted'}
      <p class="muted small"><Bell size={13} /> アプリが裏にあるときは、システム通知で知らせます。</p>
    {:else if perm === 'denied'}
      <p class="muted small">通知はブロックされています。ブラウザーの設定から許可できます。</p>
    {:else}
      <button type="button" class="btn" onclick={async () => (perm = await requestNotificationPermission())}>
        <Bell size={15} />通知を許可する
      </button>
    {/if}
  </div>

  {#if isTauri() || devUser}
    <div class="section">
      <span class="label">接続</span>
      <p class="muted small">
        <Server size={13} />
        {getServerUrl() || '同じオリジン（開発用プロキシ）'}
        {#if devUser}<br />開発ユーザー: {devUser}{/if}
      </p>
      {#if isTauri()}
        <button type="button" class="btn" onclick={changeServer}>サーバーを変更</button>
      {/if}
    </div>
  {/if}

  <div class="foot">
    <button type="button" class="btn" onclick={() => (ui.profileOpen = false)}>閉じる</button>
  </div>
</Modal>

<style>
  .who {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 18px;
  }
  .dn {
    font-weight: 700;
    font-size: 16px;
  }
  .small {
    font-size: 13px;
    margin: 0;
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
  .section {
    margin-top: 18px;
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
  .section .btn {
    margin-top: 4px;
  }
  .foot {
    display: flex;
    justify-content: flex-end;
    margin-top: 22px;
  }
</style>
