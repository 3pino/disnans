<script lang="ts">
  import type { Snippet } from 'svelte';
  import Settings from '@lucide/svelte/icons/settings';
  import Section from './ui/Section.svelte';
  import SettingRow from './ui/SettingRow.svelte';
  import SettingsField from './SettingsField.svelte';
  import { guiEnv } from '../lib/settingsBindings.svelte';
  import { guiSections, type UiPage, type UiSlot } from '../lib/uiTree';
  import { ui, type SettingsSubpage } from '../lib/stores/ui.svelte';

  // 設定の木（view::ui の Page）の 1 ページを描く。節は Section、Field は SettingsField、Link はサブページを開く行、
  // Note は控えめな文。Slot は呼び出し側（SettingsView）が id ごとに中身を描く。TUI は同じ木を ratatui で描く

  let { page, slot }: { page: UiPage; slot: Snippet<[UiSlot]> } = $props();

  /** 以前の節のクラス（CSS とテストの当て先）。無い節は settings-section-{id} */
  const SECTION_CLASS: Record<string, string> = {
    profile: 'settings-profile',
    appearance: 'settings-appearance',
    operations: 'settings-operations',
    notifications: 'settings-notifications',
    plugins: 'settings-plugins',
    connection: 'settings-connection',
    app: 'settings-app',
    enterKeys: 'enter-key-settings',
    hotkeys: 'hotkey-settings',
    navBar: 'nav-bar-settings',
    composerMenu: 'composer-menu-settings',
    call: 'call-settings',
    devices: 'device-list-settings',
  };

  const sections = $derived(guiSections(page, guiEnv()));
</script>

{#each sections as s (s.id)}
  <Section title={s.title} class={SECTION_CLASS[s.id] ?? `settings-section-${s.id}`}>
    {#each s.items as item (item.id)}
      {#if item.type === 'field'}
        <SettingsField field={item} />
      {:else if item.type === 'link'}
        <!-- 行全体がボタン。右のアイコンは飾り（読み上げは行の名前） -->
        <SettingRow name={item.label} class="settings-operation-row settings-link-{item.id}" onclick={() => ui.openSettingsSub(item.page as SettingsSubpage)}>
          {#snippet control()}
            <span class="settings-operation-icon" aria-hidden="true"><Settings size={18} /></span>
          {/snippet}
        </SettingRow>
      {:else if item.type === 'slot'}
        {@render slot(item)}
      {:else}
        <p class="muted settings-note settings-note-{item.id}">{item.text}</p>
      {/if}
    {/each}
  </Section>
{/each}

<style>
  /* 「操作」の行の右の飾りのアイコン */
  .settings-operation-icon {
    display: flex;
    color: var(--text-muted);
  }
  .settings-note {
    margin: 0;
    font-size: var(--fs-sm);
  }
</style>
