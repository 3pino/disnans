<script lang="ts">
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Button from './ui/Button.svelte';
  import SettingRow from './ui/SettingRow.svelte';
  import Toggle from './ui/Toggle.svelte';
  import PublishButton from './PublishButton.svelte';
  import { pluginHost, type ThemeEntry } from '../lib/plugins/host.svelte';
  import { themeHost } from '../lib/plugins/themes.svelte';
  import { devFolderSupported } from '../lib/plugins/dev';
  import { ui } from '../lib/stores/ui.svelte';
  import type { PluginVisibility } from '../lib/protocol/PluginVisibility';

  // 設定の「外観」のカスタムテーマ（SPEC 9.10）: 配布済み・開発中のテーマの一覧。この端末で1つだけ選べる。
  // 開発用フォルダの設定は「プラグイン」セクションのものを共用する

  const entries = $derived(pluginHost.themeEntries);
  /** 配布・削除の最中の ID */
  let busy = $state<string | null>(null);

  function nameOf(e: ThemeEntry): string {
    return e.manifest?.name ?? e.id;
  }

  function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  async function publish(e: ThemeEntry, visibility: PluginVisibility) {
    if (!e.dev) return;
    busy = e.id;
    try {
      const info = await pluginHost.publishDev(e.dev, visibility);
      ui.toast(`テーマ「${info.name}」v${info.version} を${visibility === 'private' ? '自分だけに' : 'みんなに'}配布しました`);
    } catch (err) {
      ui.toast(`配布できませんでした: ${message(err)}`, 'error');
    } finally {
      busy = null;
    }
  }

  async function remove(e: ThemeEntry) {
    const priv = e.server?.visibility === 'private';
    const ok = await ui.confirm({
      title: `テーマ「${nameOf(e)}」を削除しますか？`,
      body: `${priv ? 'あなたのすべての端末' : '全員の一覧'}から消えます。使っていた端末では、テーマなしに戻ります。`,
      okLabel: '削除',
      danger: true,
    });
    if (!ok) return;
    busy = e.id;
    try {
      await pluginHost.remove(e.id);
      ui.toast(`テーマ「${nameOf(e)}」を削除しました`);
    } catch (err) {
      ui.toast(`削除できませんでした: ${message(err)}`, 'error');
    } finally {
      busy = null;
    }
  }
</script>

<div class="theme-settings">
  <span class="field-label">カスタムテーマ</span>
  {#if entries.length === 0}
    <p class="muted theme-settings-small">
      テーマはまだありません。{devFolderSupported() ? '開発用フォルダに置くか、' : ''}誰かが配布すると、ここで選べます。
    </p>
  {/if}

  {#each entries as e (e.id)}
    {@const m = e.manifest}
    <div class="theme-settings-item">
      <SettingRow name={nameOf(e)} description={m?.description || undefined} icon={e.icon} class="theme-settings-row">
        {#snippet control()}
          <Toggle
            checked={e.selected}
            label="{nameOf(e)} を使う"
            disabled={!m || (!!e.dev?.error && !e.server)}
            onchange={(on) => themeHost.select(on ? e.id : null)}
          />
        {/snippet}
      </SettingRow>
      <div class="muted theme-settings-meta">
        {#if m}<span class="theme-settings-version">v{m.version}</span>{/if}
        {#if m?.author}<span>{m.author}</span>{/if}
        <span class="theme-settings-id">{e.id}</span>
        {#if e.dev}
          <span class="theme-settings-tag theme-settings-tag-dev">開発中{e.server ? '（配布済みより優先）' : ''}</span>
        {:else if e.server}
          <span class="theme-settings-tag">配布済み</span>
        {/if}
        {#if e.server?.visibility === 'private'}
          <span class="theme-settings-tag theme-settings-tag-private">自分だけ</span>
        {/if}
      </div>
      {#if e.error}
        <p class="theme-settings-error">{e.error}</p>
      {/if}
      {#if e.dev || e.server}
        <div class="theme-settings-actions">
          {#if e.dev}
            <PublishButton disabled={busy !== null || !e.dev.manifest || !!e.dev.error} onpublish={(v) => publish(e, v)} />
          {/if}
          {#if e.server}
            <Button variant="danger" icon={Trash2} disabled={busy !== null} onclick={() => remove(e)}>削除</Button>
          {/if}
        </div>
      {/if}
    </div>
  {/each}
</div>

<style>
  .theme-settings > * + * {
    margin-top: 6px;
  }
  .theme-settings-small {
    margin: 0;
    font-size: 13px;
  }
  .theme-settings-item {
    padding: 10px 0;
  }
  .theme-settings-item + .theme-settings-item {
    border-top: 1px solid var(--border);
  }
  .theme-settings-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 10px;
    margin-top: 4px;
    font-size: 12px;
  }
  .theme-settings-version,
  .theme-settings-id {
    font-family: var(--mono);
  }
  .theme-settings-tag {
    padding: 0 6px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
  }
  .theme-settings-tag.theme-settings-tag-dev {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .theme-settings-tag.theme-settings-tag-private {
    background: var(--mention-soft);
    color: var(--mention);
  }
  .theme-settings-error {
    margin: 6px 0 0;
    color: var(--danger);
    font-size: 13px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .theme-settings-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 8px;
  }
</style>
