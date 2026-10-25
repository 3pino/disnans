<script lang="ts">
  import SettingRow from './ui/SettingRow.svelte';
  import SegmentedButton from './ui/SegmentedButton.svelte';
  import Slider from './ui/Slider.svelte';
  import Toggle from './ui/Toggle.svelte';
  import { fieldBinding, fieldLabel } from '../lib/settingsBindings.svelte';
  import type { UiField } from '../lib/uiTree';

  // 設定の木の Field 1 つ（SettingRow + 部品）。部品の種類は木（view::ui の Control）が決め、値は lib/settingsBindings で読み書きする。
  // TUI は同じ Field を、Toggle・Choice・数の入力で描く（crates/cli/src/tui/settings.rs）

  let { field }: { field: UiField } = $props();

  /** 以前のクラス（CSS の当て先）。新しい項目には足さない */
  const ROW_CLASS: Record<string, string> = {
    orientation: 'settings-orientation-row',
    hideNavigationBar: 'settings-hide-nav-bar-row',
  };

  const binding = $derived(fieldBinding(field.key));
  const label = $derived(fieldLabel(field));
  const rowClass = $derived(
    `settings-field settings-field-${field.control.type} ${ROW_CLASS[field.id] ?? ''} ${field.key.startsWith('enterKeys.') ? 'enter-key-settings-row' : ''}`,
  );
</script>

{#if binding}
  <SettingRow name={label} icon={field.icon ?? undefined} class={rowClass}>
    {#snippet control()}
      {@const c = field.control}
      {#if c.type === 'toggle'}
        <Toggle checked={!!binding.get()} {label} onchange={(on) => binding.set(on)} />
      {:else if c.type === 'segmented'}
        <SegmentedButton
          class="settings-field-picker"
          {label}
          options={c.options.map((o) => ({ value: o.value, label: o.label, icon: o.icon ?? undefined }))}
          value={String(binding.get())}
          onchange={(v) => binding.set(v)}
        />
      {:else if c.type === 'select'}
        <select class="input settings-field-select" aria-label={label} value={String(binding.get())} onchange={(e) => binding.set(e.currentTarget.value)}>
          {#each c.options as o (o.value)}
            <option value={o.value}>{o.label}</option>
          {/each}
        </select>
      {:else}
        <Slider
          {label}
          min={c.min}
          max={c.max}
          step={c.step}
          value={Math.round(Number(binding.get()) * c.scale)}
          format={(v) => `${v}${c.unit}`}
          oninput={(v) => (binding.preview ?? binding.set)(v / c.scale)}
          onchange={(v) => binding.set(v / c.scale)}
        />
      {/if}
    {/snippet}
  </SettingRow>
{/if}

<style>
  /* 横に並んだ選択肢は、窮屈にならない幅で並べる（行が狭いときは、行の折り返しで操作が下の段へ回る） */
  :global(.settings-field-segmented .setting-row-control) {
    width: 264px;
  }
  /* SettingRow は操作を div で包むので、その div も幅いっぱいにする */
  :global(.settings-field-segmented .setting-row-control > div) {
    flex: 1;
    min-width: 0;
  }
  :global(.settings-field-picker) {
    width: 100%;
  }
  /* 選択（.input の幅いっぱいにせず、中身の幅に合わせる） */
  .settings-field-select {
    width: auto;
    max-width: 260px;
  }
</style>
