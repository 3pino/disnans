<script lang="ts">
  import Upload from '@lucide/svelte/icons/upload';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Settings2 from '@lucide/svelte/icons/settings-2';
  import FolderOpen from '@lucide/svelte/icons/folder-open';
  import FolderSearch from '@lucide/svelte/icons/folder-search';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import Button from './ui/Button.svelte';
  import Section from './ui/Section.svelte';
  import SettingRow from './ui/SettingRow.svelte';
  import StatusLine from './ui/StatusLine.svelte';
  import TextInput from './ui/TextInput.svelte';
  import Toggle from './ui/Toggle.svelte';
  import PluginSettingTab from './PluginSettingTab.svelte';
  import { pluginHost, type PluginEntry } from '../lib/plugins/host.svelte';
  import { devFolderSupported } from '../lib/plugins/dev';
  import { isTauri } from '../lib/config';
  import { ui } from '../lib/stores/ui.svelte';

  // 設定の「プラグイン」セクション: 配布済み・開発中の一覧、開発用フォルダ（PC 版）、ファイルを選んで配布（ブラウザー版）

  const entries = $derived(pluginHost.entries);
  const devSupported = devFolderSupported();
  /** ブラウザー版（開発用）は、開発用フォルダの代わりにファイルを選んで配布する */
  const browser = !isTauri();

  // svelte-ignore state_referenced_locally
  let devDir = $state(pluginHost.devDir);
  /** 配布・削除の最中の ID */
  let busy = $state<string | null>(null);
  /** 設定タブを開いている ID */
  let openSettings = $state<string | null>(null);
  let fileInput: HTMLInputElement | undefined = $state();

  function nameOf(e: PluginEntry): string {
    return e.manifest?.name ?? e.id;
  }

  function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  async function publish(e: PluginEntry) {
    if (!e.dev) return;
    busy = e.id;
    try {
      const info = await pluginHost.publishDev(e.dev);
      ui.toast(`「${info.name}」v${info.version} を配布しました`);
    } catch (err) {
      ui.toast(`配布できませんでした: ${message(err)}`, 'error');
    } finally {
      busy = null;
    }
  }

  async function remove(e: PluginEntry) {
    const ok = await ui.confirm({
      title: `プラグイン「${nameOf(e)}」を削除しますか？`,
      body: '全員のクライアントから外れます。セッションとカードは残り、同じ ID で配布し直せばまた開けます。',
      okLabel: '削除',
      danger: true,
    });
    if (!ok) return;
    busy = e.id;
    try {
      await pluginHost.remove(e.id);
      ui.toast(`「${nameOf(e)}」を削除しました`);
    } catch (err) {
      ui.toast(`削除できませんでした: ${message(err)}`, 'error');
    } finally {
      busy = null;
    }
  }

  async function publishPicked() {
    const files = [...(fileInput?.files ?? [])];
    if (fileInput) fileInput.value = '';
    if (files.length === 0) return;
    busy = '__files__';
    try {
      const info = await pluginHost.publishFiles(files);
      ui.toast(`「${info.name}」v${info.version} を配布しました`);
    } catch (err) {
      ui.toast(`配布できませんでした: ${message(err)}`, 'error');
    } finally {
      busy = null;
    }
  }

  function saveDevDir(ev: SubmitEvent) {
    ev.preventDefault();
    pluginHost.setDevDir(devDir);
  }

  /** フォルダを選ぶダイアログ（PC 版）。選んだらそのまま設定する */
  async function browseDevDir() {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({ directory: true, multiple: false, defaultPath: devDir.trim() || undefined, title: '開発用フォルダを選ぶ' });
      if (typeof picked !== 'string') return;
      devDir = picked;
      pluginHost.setDevDir(picked);
    } catch (err) {
      ui.toast(`フォルダを選べませんでした: ${message(err)}`, 'error');
    }
  }
</script>

<Section title="プラグイン" class="settings-plugins">
  {#if pluginHost.serverError}
    <StatusLine kind="error" icon={CircleAlert}>{pluginHost.serverError}</StatusLine>
  {/if}

  {#if entries.length === 0}
    <p class="muted plugin-settings-empty">プラグインはまだありません。</p>
  {/if}

  {#each entries as e (e.id)}
    {@const m = e.manifest}
    <div class="plugin-settings-item" class:plugin-settings-item-off={!e.enabled}>
      <SettingRow name={nameOf(e)} description={m?.description || undefined} icon={e.icon} class="plugin-settings-row">
        {#snippet control()}
          <Toggle checked={e.enabled} label="{nameOf(e)} を有効にする" onchange={(on) => pluginHost.setEnabled(e.id, on)} />
        {/snippet}
      </SettingRow>
      <div class="muted plugin-settings-meta">
        {#if m}<span class="plugin-settings-version">v{m.version}</span>{/if}
        {#if m?.author}<span>{m.author}</span>{/if}
        <span class="plugin-settings-id">{e.id}</span>
        {#if e.dev}
          <span class="plugin-settings-tag plugin-settings-tag-dev">開発中{e.server ? '（配布済みより優先）' : ''}</span>
        {:else if e.server}
          <span class="plugin-settings-tag">配布済み</span>
        {/if}
      </div>
      {#if e.error}
        <p class="plugin-settings-error">{e.error}</p>
      {/if}

      {#if e.dev || e.server || e.hasSettings}
        <div class="plugin-settings-actions">
          {#if e.hasSettings}
            <Button onclick={() => (openSettings = openSettings === e.id ? null : e.id)}>
              <Settings2 size={15} />{openSettings === e.id ? '設定を閉じる' : '設定'}
            </Button>
          {/if}
          {#if e.dev}
            <Button disabled={busy !== null || !e.dev.manifest || !!e.dev.error} onclick={() => publish(e)}>
              <Upload size={15} />配布
            </Button>
          {/if}
          {#if e.server}
            <Button variant="danger" disabled={busy !== null} onclick={() => remove(e)}>
              <Trash2 size={15} />削除
            </Button>
          {/if}
        </div>
      {/if}

      {#if openSettings === e.id && e.hasSettings}
        <div class="plugin-settings-tabs">
          {#each pluginHost.settingTabs(e.id) as tab, i (i)}
            <PluginSettingTab {tab} name={nameOf(e)} />
          {/each}
        </div>
      {/if}
    </div>
  {/each}

  {#if devSupported}
    <form class="plugin-settings-dev" onsubmit={saveDevDir}>
      <label class="field-label" for="plugin-settings-dev-dir">開発用フォルダ</label>
      <div class="plugin-settings-dev-row">
        <TextInput id="plugin-settings-dev-dir" bind:value={devDir} placeholder="例: /home/you/disnans-plugins" autocomplete="off" spellcheck={false} />
        <Button icon={FolderSearch} onclick={browseDevDir}>参照…</Button>
        <Button type="submit" disabled={devDir.trim() === pluginHost.devDir}><FolderOpen size={15} />設定</Button>
      </div>
      <p class="muted plugin-settings-small">
        フォルダの中のサブフォルダ（manifest.json と main.js）を、この端末でだけ読み込みます。保存すると自動で読み込み直します。
      </p>
      {#if pluginHost.devError}
        <StatusLine kind="error" icon={CircleAlert}>{pluginHost.devError}</StatusLine>
      {/if}
    </form>
  {/if}

  {#if browser}
    <div class="plugin-settings-upload">
      <span class="field-label">ファイルを選んで配布</span>
      <p class="muted plugin-settings-small">manifest.json と main.js（と styles.css・icon.svg）をまとめて選びます。</p>
      <input bind:this={fileInput} class="sr-only" type="file" multiple accept=".json,.js,.css,.svg" onchange={publishPicked} />
      <Button disabled={busy !== null} onclick={() => fileInput?.click()}><Upload size={15} />ファイルを選ぶ</Button>
    </div>
  {/if}
</Section>

<style>
  .plugin-settings-empty,
  .plugin-settings-small {
    margin: 0;
    font-size: 13px;
  }
  .plugin-settings-item {
    padding: 10px 0;
  }
  .plugin-settings-item + .plugin-settings-item {
    border-top: 1px solid var(--border);
  }
  .plugin-settings-item.plugin-settings-item-off :global(.plugin-settings-row .setting-row-name) {
    color: var(--text-muted);
  }
  .plugin-settings-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 10px;
    margin-top: 4px;
    font-size: 12px;
  }
  .plugin-settings-version,
  .plugin-settings-id {
    font-family: var(--mono);
  }
  .plugin-settings-tag {
    padding: 0 6px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
  }
  .plugin-settings-tag.plugin-settings-tag-dev {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .plugin-settings-error {
    margin: 6px 0 0;
    color: var(--danger);
    font-size: 13px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    -webkit-user-select: text;
    user-select: text;
  }
  .plugin-settings-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 8px;
  }
  .plugin-settings-tabs {
    margin-top: 10px;
    padding: 12px;
    border-radius: var(--radius-sm);
    background: var(--surface);
  }
  .plugin-settings-dev,
  .plugin-settings-upload {
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  .plugin-settings-dev > * + *,
  .plugin-settings-upload > * + * {
    margin-top: 6px;
  }
  .plugin-settings-dev-row {
    display: flex;
    gap: 8px;
  }
  .plugin-settings-dev-row > :global(.input) {
    flex: 1;
    min-width: 0;
  }
  .plugin-settings-dev-row > :global(.btn) {
    height: 40px;
  }
</style>
