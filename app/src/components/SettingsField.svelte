<script lang="ts">
  import SettingsFieldRow from '@3pino/app-kit-web/settings/SettingsField.svelte';
  import { fieldBinding, fieldLabel } from '../lib/settingsBindings.svelte';
  import type { UiField } from '../lib/uiTree';

  // 設定の木の Field 1 つ。行と部品は土台（@3pino/app-kit-web/settings）が描く。ここは、木の Field を、disnans の読み書き（settingsBindings）と名前・行のクラスに変えるだけ。
  // TUI は同じ Field を、Toggle・Choice・数の入力で描く（crates/cli/src/tui/settings.rs）

  let { field }: { field: UiField } = $props();

  /** 以前のクラス（CSS の当て先）。新しい項目には足さない */
  const ROW_CLASS: Record<string, string> = {
    orientation: 'settings-orientation-row',
    hideNavigationBar: 'settings-hide-nav-bar-row',
  };

  const rowClass = $derived(
    `settings-field settings-field-${field.control.type} ${ROW_CLASS[field.id] ?? ''} ${field.key.startsWith('enterKeys.') ? 'enter-key-settings-row' : ''}`,
  );
</script>

<SettingsFieldRow label={fieldLabel(field)} icon={field.icon ?? undefined} {rowClass} binding={fieldBinding(field.key)} spec={field.control} />
