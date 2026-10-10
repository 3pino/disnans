<script lang="ts">
  import { onMount } from 'svelte';
  import Mic from '@lucide/svelte/icons/mic';
  import MicOff from '@lucide/svelte/icons/mic-off';
  import Volume2 from '@lucide/svelte/icons/volume-2';
  import Headphones from '@lucide/svelte/icons/headphones';
  import Section from './ui/Section.svelte';
  import SettingRow from './ui/SettingRow.svelte';
  import Slider from './ui/Slider.svelte';
  import Toggle from './ui/Toggle.svelte';
  import { call } from '../lib/call/instance.svelte';
  import { callSettings } from '../lib/call/settings.svelte';
  import { MIC_VOLUME_MAX, OUT_VOLUME_MAX } from '../lib/call/pure';
  import { audio } from '../lib/plugins/audio';

  // 設定の「通話」。この端末だけの設定で、サーバーには送らない（lib/call/settings.svelte.ts）

  const s = $derived(callSettings.value);
  let inputs = $state<Disnans.AudioInput[]>([]);

  onMount(() => {
    // 機器の一覧は、開いたときに取る（使えない環境では行ごと出さない）
    void call.refreshOutputs();
    void audio.listInputs().then((list) => (inputs = list));
  });

  const selectedOutput = $derived(call.outputs.find((o) => o.selected)?.id ?? '');

  /** 動かしている間は反映だけして、離したときに保存する（v は％） */
  function slide(key: 'micVolume' | 'outVolume', v: number) {
    callSettings.preview({ [key]: v / 100 });
    if (key === 'micVolume') call.applyMicVolume();
    else call.applyOutVolume();
  }
</script>

<Section title="通話" class="call-settings">
  <SettingRow name="参加したときミュートにする" icon={MicOff}>
    {#snippet control()}
      <Toggle checked={s.joinMuted} label="参加したときミュートにする" onchange={(v) => callSettings.patch({ joinMuted: v })} />
    {/snippet}
  </SettingRow>

  <SettingRow name="マイクの音量" icon={Mic}>
    {#snippet control()}
      <Slider
        label="マイクの音量"
        min={0}
        max={Math.round(MIC_VOLUME_MAX * 100)}
        step={5}
        value={Math.round(s.micVolume * 100)}
        format={(v) => `${v}%`}
        oninput={(v) => slide('micVolume', v)}
        onchange={() => callSettings.save()}
      />
    {/snippet}
  </SettingRow>

  <SettingRow name="相手の音量" icon={Volume2}>
    {#snippet control()}
      <Slider
        label="相手の音量"
        min={0}
        max={Math.round(OUT_VOLUME_MAX * 100)}
        step={5}
        value={Math.round(s.outVolume * 100)}
        format={(v) => `${v}%`}
        oninput={(v) => slide('outVolume', v)}
        onchange={() => callSettings.save()}
      />
    {/snippet}
  </SettingRow>

  {#if call.outputs.length > 0}
    <SettingRow name="音の出力先" icon={Headphones}>
      {#snippet control()}
        <select class="input call-select" aria-label="音の出力先" value={selectedOutput} onchange={(e) => void call.chooseOutput(e.currentTarget.value)}>
          {#each call.outputs as o (o.id)}
            <option value={o.id}>{o.label}</option>
          {/each}
        </select>
      {/snippet}
    </SettingRow>
  {/if}

  {#if inputs.length > 0}
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

</Section>

<style>
  /* 機器の選択欄は幅を抑え、長い名前は「…」で省略する */
  .call-select {
    max-width: 260px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
</style>
