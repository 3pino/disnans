<script lang="ts">
  import Section from './ui/Section.svelte';
  import SettingRow from './ui/SettingRow.svelte';
  import SegmentedButton from './ui/SegmentedButton.svelte';
  import { ENTER_COMBOS, enterComboLabel, type EnterAction } from '../lib/enterKeys';
  import { prefs } from '../lib/stores/prefs.svelte';

  // 設定の「操作」→「入力欄のキー」。Enter の組み合わせごとの動作を決める。
  // サーバーに保存し、同じユーザーの端末で共有する（lib/stores/prefs.svelte.ts）

  const enterOptions: { value: EnterAction; label: string }[] = [
    { value: 'send', label: '送信' },
    { value: 'newline', label: '改行' },
    { value: 'none', label: 'なし' },
  ];
</script>

<Section title="入力欄のキー" class="enter-key-settings">
  {#each ENTER_COMBOS as combo (combo)}
    <SettingRow name={enterComboLabel(combo)} class="enter-key-settings-row">
      {#snippet control()}
        <SegmentedButton
          class="enter-key-settings-picker"
          label={`${enterComboLabel(combo)} の動作`}
          options={enterOptions}
          value={prefs.enterKeys[combo]}
          onchange={(v) => prefs.setEnterAction(combo, v)}
        />
      {/snippet}
    </SettingRow>
  {/each}
  <p class="muted enter-key-settings-note">メッセージの編集では「送信」が保存になります。この設定はほかの端末とも共有されます</p>
</Section>

<style>
  .enter-key-settings-note {
    margin: 0;
    font-size: 13px;
  }
  /* 「改行・送信・なし」の3つを、窮屈にならない幅で並べる（名前の欄とは、狭いときは比率で分ける） */
  :global(.enter-key-settings-row .setting-row-control) {
    width: min(264px, 62%);
  }
  :global(.enter-key-settings-picker) {
    width: 100%;
  }
</style>
