<script lang="ts">
  import { onDestroy } from 'svelte';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import X from '@lucide/svelte/icons/x';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import Button from './ui/Button.svelte';
  import IconButton from './ui/IconButton.svelte';
  import Section from './ui/Section.svelte';
  import SettingRow from './ui/SettingRow.svelte';
  import StatusLine from './ui/StatusLine.svelte';
  import { commandList, effectiveHotkey, filterCommands, findHotkeyConflicts, isHotkeyCustomized, type AppCommand } from '../lib/commands.svelte';
  import { commandHost, PALETTE_COMMAND_ID } from '../lib/commandHost.svelte';
  import { formatHotkey, hotkeyFromEvent, hotkeyId } from '../lib/plugins/hotkey';
  import { prefs } from '../lib/stores/prefs.svelte';

  // 設定の「操作」→「ホットキー」（デスクトップのみ）。コマンドごとのショートカットを決める。
  // サーバーに保存し、同じユーザーの端末で共有する（lib/stores/prefs.svelte.ts）

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

<Section title="ショートカット" class="hotkey-settings">
  <p class="muted hotkey-settings-note">
    キーの欄を押してから、割り当てたいキーを押します（Esc で取り消し）。{#if paletteHotkey}コマンドパレット（{paletteHotkey}）からも実行できます。{/if}この設定はほかの端末とも共有されます
  </p>
  {#each commands as c (c.id)}
    {@const hotkey = effectiveHotkey(c, prefs.hotkeys)}
    {@const same = conflicts.get(c.id)}
    <div class="hotkey-settings-command" class:hotkey-settings-command-conflict={!!same}>
      <SettingRow name={c.name} description={[c.source, c.slash && `/${c.slash}`].filter(Boolean).join(' · ') || undefined} icon={c.icon} class="hotkey-settings-row">
        {#snippet control()}
          <Button
            class="hotkey-settings-key {recording === c.id ? 'hotkey-settings-key-recording' : ''}"
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
            class="hotkey-settings-reset"
            label="既定に戻す"
            title="既定に戻す"
            icon={RotateCcw}
            iconSize={16}
            disabled={!isHotkeyCustomized(c, prefs.hotkeys)}
            onclick={() => prefs.setHotkey(c.id, null)}
          />
          <IconButton
            class="hotkey-settings-clear"
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
        <StatusLine kind="warn" icon={TriangleAlert} class="hotkey-settings-conflict">
          「{same.map((x) => x.name).join('」「')}」と同じキーです
        </StatusLine>
      {/if}
    </div>
  {/each}
</Section>

<style>
  .hotkey-settings-note {
    margin: 0;
    font-size: 13px;
  }
  /* ほかのコマンドと同じキーになっているときの警告 */
  .hotkey-settings-command > :global(.hotkey-settings-conflict) {
    margin-top: 4px;
    font-size: 13px;
  }
  .hotkey-settings-command :global(.hotkey-settings-key) {
    min-width: 96px;
    justify-content: center;
  }
  /* 記録中は、キーを待っていることがわかるようにアクセントの色にする */
  .hotkey-settings-command :global(.hotkey-settings-key.hotkey-settings-key-recording) {
    border-color: var(--accent);
    color: var(--accent);
  }
  /* 押せないときは隠す（位置はそろえたまま） */
  .hotkey-settings-command :global(.hotkey-settings-reset:disabled),
  .hotkey-settings-command :global(.hotkey-settings-clear:disabled) {
    visibility: hidden;
  }
</style>
