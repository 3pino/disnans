<script lang="ts">
  import { onMount } from 'svelte';
  import Mic from '@lucide/svelte/icons/mic';
  import Headphones from '@lucide/svelte/icons/headphones';
  import SettingRow from './ui/SettingRow.svelte';
  import { call } from '../lib/call/instance.svelte';
  import { callSettings } from '../lib/call/settings.svelte';
  import { audio } from '../lib/plugins/audio';

  // 設定の「通話」の機器の行（設定の木の Slot `callDevices`。ほかの行は木の Field が描く）。
  // 機器はこのデバイスだけに保存する（lib/call/settings.svelte.ts）
  // Android のネイティブ所有の通話は、マイクをネイティブ（Android の通話用の入力）が選ぶ。Web の機器の一覧は使わず、保存した値も消さない

  const s = $derived(callSettings.value);
  let inputs = $state<Disnans.AudioInput[]>([]);

  onMount(() => {
    // 機器の一覧は、開いたときに取る（使えない環境では行ごと出さない）
    void call.refreshOutputs();
    if (!call.nativeOwned) void audio.listInputs().then((list) => (inputs = list));
  });

  const selectedOutput = $derived(call.outputs.find((o) => o.selected)?.id ?? '');
</script>

{#if call.outputs.length > 0}
  <SettingRow name="音の出力先" icon={Headphones}>
    {#snippet control()}
      <select class="input call-select" aria-label="音の出力先" value={selectedOutput} onchange={(e) => void call.chooseOutput(e.currentTarget.value)}>
        {#if !selectedOutput}<option value="" disabled></option>{/if}
        {#each call.outputs as o (o.id)}
          <option value={o.id}>{o.label}</option>
        {/each}
      </select>
    {/snippet}
  </SettingRow>
{/if}

{#if call.nativeOwned}
  <SettingRow name="マイク" icon={Mic}>
    {#snippet control()}
      <span class="call-device-value">Android の通話用マイク</span>
    {/snippet}
  </SettingRow>
{:else if inputs.length > 0}
  <SettingRow name="マイク" icon={Mic}>
    {#snippet control()}
      <select
        class="input call-select"
        aria-label="マイク"
        value={inputs.some((d) => d.id === s.inputId) ? s.inputId : ''}
        onchange={(e) => callSettings.patch({ inputId: e.currentTarget.value })}
      >
        <option value="">既定</option>
        {#each inputs as d (d.id)}
          <option value={d.id}>{d.label}</option>
        {/each}
      </select>
    {/snippet}
  </SettingRow>
{/if}

<style>
  /* 機器の選択欄は幅を抑え、長い名前は「…」で省略する */
  .call-select {
    max-width: 260px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  /* ネイティブが選ぶ入力の説明（操作はできない。読むだけの値） */
  .call-device-value {
    color: var(--text-muted);
  }
</style>
