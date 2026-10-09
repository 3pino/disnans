<script lang="ts">
  import { onDestroy } from 'svelte';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import X from '@lucide/svelte/icons/x';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import Button from './ui/Button.svelte';
  import IconButton from './ui/IconButton.svelte';
  import Section from './ui/Section.svelte';
  import SettingRow from './ui/SettingRow.svelte';
  import SegmentedButton from './ui/SegmentedButton.svelte';
  import StatusLine from './ui/StatusLine.svelte';
  import { commandList, effectiveHotkey, filterCommands, findHotkeyConflicts, isHotkeyCustomized, type AppCommand } from '../lib/commands.svelte';
  import { commandHost, PALETTE_COMMAND_ID } from '../lib/commandHost.svelte';
  import { ENTER_COMBOS, enterComboLabel, type EnterAction } from '../lib/enterKeys';
  import { formatHotkey, hotkeyFromEvent, hotkeyId } from '../lib/plugins/hotkey';
  import { prefs } from '../lib/stores/prefs.svelte';
  import { isAndroid } from '../lib/config';

  // 設定の「入力欄のキー」（Enter の組み合わせごとの動作）と「ショートカット」（デスクトップ）。
  // どちらもサーバーに保存し、同じユーザーの端末で共有する（lib/stores/prefs.svelte.ts）

  const enterOptions: { value: EnterAction; label: string }[] = [
    { value: 'send', label: '送信' },
    { value: 'newline', label: '改行' },
    { value: 'none', label: 'なし' },
  ];

  /** 本体のもの → プラグインのもの、それぞれ名前順 */
  const commands = $derived(filterCommands(commandList(), ''));
  const conflicts = $derived(findHotkeyConflicts(commands, prefs.hotkeys));
  const paletteHotkey = $derived.by(() => {
    const c = commands.find((x) => x.id === PALETTE_COMMAND_ID);
    const hk = c ? effectiveHotkey(c, prefs.hotkeys) : '';
    return hk ? formatHotkey(hk) : null;
  });

  /** ショートカットを記録しているコマンド */
  let recording = $state<string | null>(null);

  function startRecording(c: AppCommand) {
    recording = c.id;
    commandHost.recording = true;
  }

  function stopRecording() {
    recording = null;
    commandHost.recording = false;
  }

  onDestroy(() => {
    if (recording) commandHost.recording = false;
  });

  /** 記録中のキー入力。ほかの処理（ショートカット・Esc で閉じるなど）に渡さない */
  function onRecordKey(e: KeyboardEvent) {
    if (!recording || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    e.stopPropagation();
    // 修飾キーなしの Esc は取り消し
    if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      stopRecording();
      return;
    }
    const text = hotkeyFromEvent(e);
    // 修飾キーだけのときは、続けて押すキーを待つ
    if (!text) return;
    const c = commands.find((x) => x.id === recording);
    if (c) {
      // 既定と同じなら設定を消す（既定が変わったときに追従するように）
      const same = !!c.defaultHotkey && hotkeyId(c.defaultHotkey) === hotkeyId(text);
      prefs.setHotkey(c.id, same ? null : text);
    }
    stopRecording();
  }
</script>

<svelte:window onkeydowncapture={onRecordKey} />

<Section title="入力欄のキー" class="key-settings-enter">
  {#each ENTER_COMBOS as combo (combo)}
    <SettingRow name={enterComboLabel(combo)} class="key-settings-enter-row">
      {#snippet control()}
        <SegmentedButton
          class="key-settings-enter-picker"
          label={`${enterComboLabel(combo)} の動作`}
          options={enterOptions}
          value={prefs.enterKeys[combo]}
          onchange={(v) => prefs.setEnterAction(combo, v)}
        />
      {/snippet}
    </SettingRow>
  {/each}
  <p class="muted key-settings-note">メッセージの編集では「送信」が保存になります。この設定はほかの端末とも共有されます</p>
</Section>

{#if !isAndroid()}
  <Section title="ショートカット" class="key-settings-hotkeys">
    <p class="muted key-settings-note">
      キーの欄を押してから、割り当てたいキーを押します（Esc で取り消し）。{#if paletteHotkey}コマンドパレット（{paletteHotkey}）からも実行できます。{/if}この設定はほかの端末とも共有されます
    </p>
    {#each commands as c (c.id)}
      {@const hotkey = effectiveHotkey(c, prefs.hotkeys)}
      {@const same = conflicts.get(c.id)}
      <div class="key-settings-command" class:key-settings-command-conflict={!!same}>
        <SettingRow name={c.name} description={[c.source, c.slash && `/${c.slash}`].filter(Boolean).join(' · ') || undefined} icon={c.icon} class="key-settings-row">
          {#snippet control()}
            <Button
              class="key-settings-hotkey {recording === c.id ? 'key-settings-hotkey-recording' : ''}"
              aria-label={`${c.name} のショートカットを変更`}
              onclick={() => (recording === c.id ? stopRecording() : startRecording(c))}
              onblur={() => recording === c.id && stopRecording()}
            >
              {#if recording === c.id}
                キーを押してください…
              {:else if hotkey}
                <kbd class="kbd">{formatHotkey(hotkey)}</kbd>
              {:else}
                <span class="muted">なし</span>
              {/if}
            </Button>
            <IconButton
              class="key-settings-reset"
              label="既定に戻す"
              title="既定に戻す"
              icon={RotateCcw}
              iconSize={16}
              disabled={!isHotkeyCustomized(c, prefs.hotkeys)}
              onclick={() => prefs.setHotkey(c.id, null)}
            />
            <IconButton
              class="key-settings-clear"
              label="ショートカットを外す"
              title="ショートカットを外す"
              icon={X}
              iconSize={16}
              disabled={!hotkey}
              onclick={() => prefs.setHotkey(c.id, c.defaultHotkey ? '' : null)}
            />
          {/snippet}
        </SettingRow>
        {#if same}
          <StatusLine kind="warn" icon={TriangleAlert} class="key-settings-conflict">
            「{same.map((x) => x.name).join('」「')}」と同じキーです
          </StatusLine>
        {/if}
      </div>
    {/each}
  </Section>
{/if}

<style>
  .key-settings-note {
    margin: 0;
    font-size: 13px;
  }
  /* 「改行・送信・なし」の3つを、窮屈にならない幅で並べる（名前の欄とは、狭いときは比率で分ける） */
  :global(.key-settings-enter-row .setting-row-control) {
    width: min(264px, 62%);
  }
  :global(.key-settings-enter-picker) {
    width: 100%;
  }
  /* ほかのコマンドと同じキーになっているときの警告 */
  .key-settings-command > :global(.key-settings-conflict) {
    margin-top: 4px;
    font-size: 13px;
  }
  .key-settings-command :global(.key-settings-hotkey) {
    min-width: 96px;
    justify-content: center;
  }
  /* 記録中は、キーを待っていることがわかるようにアクセントの色にする */
  .key-settings-command :global(.key-settings-hotkey.key-settings-hotkey-recording) {
    border-color: var(--accent);
    color: var(--accent);
  }
  /* 押せないときは隠す（位置はそろえたまま） */
  .key-settings-command :global(.key-settings-reset:disabled),
  .key-settings-command :global(.key-settings-clear:disabled) {
    visibility: hidden;
  }
</style>
