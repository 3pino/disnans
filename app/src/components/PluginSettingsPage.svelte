<script lang="ts">
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import IconButton from './ui/IconButton.svelte';
  import Icon from './ui/Icon.svelte';
  import PluginSettingTab from './PluginSettingTab.svelte';
  import PluginManageSection from './PluginManageSection.svelte';
  import { pluginHost } from '../lib/plugins/host.svelte';
  import { ui } from '../lib/stores/ui.svelte';

  // 設定 > プラグイン の歯車から開く、1つのプラグインの設定画面。設定の一覧の代わりに出す（デスクトップは右側、モバイルは全体）。
  // 上は戻るボタン・プラグインのアイコン・名前、下はプラグインが描く設定タブ（addSettingTab）
  let { id }: { id: string } = $props();

  const entry = $derived(pluginHost.entries.find((e) => e.id === id));
  const name = $derived(entry?.manifest?.name ?? id);
  const tabs = $derived(entry?.hasSettings ? pluginHost.settingTabs(id) : []);
  /** 開発中（配布）か配布済み（削除）のときは、下に「配布と削除」を出す */
  const manageable = $derived(!!entry && (!!entry.dev || !!entry.server));
</script>

<div id="plugin-settings-page" class="plugin-settings-page" data-plugin={id}>
  <header class="top-bar"></header>
  <div class="plugin-settings-page-header">
    <IconButton class="plugin-settings-page-back" label="戻る" onclick={() => ui.closePluginSettings()}><ArrowLeft size={20} /></IconButton>
    <div class="plugin-settings-page-title">
      <Icon icon={entry?.icon ?? pluginHost.pluginIcon(id)} size={18} />
      <span class="plugin-settings-page-title-text">{name}</span>
    </div>
  </div>

  <div class="scroll plugin-settings-page-body">
    <div class="plugin-settings-page-content">
      {#each tabs as tab, i (i)}
        <PluginSettingTab {tab} {name} />
      {/each}
      {#if entry && manageable}
        <PluginManageSection {entry} />
      {/if}
      {#if tabs.length === 0 && !manageable}
        <p class="muted plugin-settings-page-empty">このプラグインには設定がありません。</p>
      {/if}
    </div>
  </div>
</div>

<style>
  /* 設定画面と同じく、文字は選択できないようにする（入力欄は除く） */
  .plugin-settings-page {
    -webkit-user-select: none;
    user-select: none;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
    min-height: 0;
  }
  .plugin-settings-page-header {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 52px;
    padding: 0 16px 0 8px;
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .plugin-settings-page-title {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    font-weight: 650;
  }
  .plugin-settings-page-title > :global(.icon) {
    flex: none;
  }
  .plugin-settings-page-title-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .plugin-settings-page-body {
    flex: 1;
    min-height: 0;
  }
  .plugin-settings-page-content {
    display: flex;
    flex-direction: column;
    gap: 16px;
    max-width: 640px;
    margin: 0 auto;
    padding: 16px 16px 32px;
  }
  .plugin-settings-page-empty {
    margin: 0;
    font-size: 13px;
  }
</style>
