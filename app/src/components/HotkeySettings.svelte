<script lang="ts">
  import { onDestroy } from 'svelte';
  import Plus from '@lucide/svelte/icons/plus';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Check from '@lucide/svelte/icons/check';
  import X from '@lucide/svelte/icons/x';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import IconButton from './ui/IconButton.svelte';
  import Section from './ui/Section.svelte';
  import SettingRow from './ui/SettingRow.svelte';
  import StatusLine from './ui/StatusLine.svelte';
  import TextInput from './ui/TextInput.svelte';
  import {
    addHotkey,
    commandList,
    effectiveHotkeys,
    effectiveSlash,
    filterCommands,
    findHotkeyConflicts,
    hotkeyOverride,
    isHotkeyCustomized,
    removeHotkey,
    type AppCommand,
  } from '../lib/commands.svelte';
  import { commandHost, PALETTE_COMMAND_ID } from '../lib/commandHost.svelte';
  import { formatHotkey, hotkeyFromEvent } from '../lib/plugins/hotkey';
  import { checkSlashAlias } from '../lib/slashAlias';
  import { slashCommands } from '../lib/slashCommands.svelte';
  import { prefs } from '../lib/stores/prefs.svelte';

  // 設定の「操作」→「ホットキー」（デスクトップのみ）。コマンドごとのホットキーを複数決め、
  // スラッシュコマンドの名前（別名）も変えられる。保存はサーバーに置き（lib/stores/prefs.svelte.ts）、同じユーザーの端末で共有する

  /** 本体のもの → プラグインのもの、それぞれ名前順 */
  const commands = $derived(filterCommands(commandList(), ''));
  const conflicts = $derived(findHotkeyConflicts(commands, prefs.hotkeys));
  const paletteHotkey = $derived.by(() => {
    const c = commands.find((x) => x.id === PALETTE_COMMAND_ID);
    const hk = c ? effectiveHotkeys(c, prefs.hotkeys)[0] : undefined;
    return hk ? formatHotkey(hk) : null;
  });

  /** ホットキーを記録しているコマンド */
  let recording = $state<string | null>(null);

  function startRecording(c: AppCommand) {
    stopSlashEdit();
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

  /** 記録中のキー入力。ほかの処理（ホットキー・Esc で閉じるなど）に渡さない */
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
    // 同じキーがほかのコマンドにあっても、既存の挙動に合わせて足すだけ（行に警告を出す）
    if (c) setHotkeys(c, addHotkey(effectiveHotkeys(c, prefs.hotkeys), text));
    stopRecording();
  }

  /** 一覧を保存する。既定と同じなら設定を消す（既定が変わったときに追従する） */
  function setHotkeys(c: AppCommand, list: string[]) {
    prefs.setHotkeys(c.id, hotkeyOverride(c, list));
  }

  function removeKey(c: AppCommand, text: string) {
    setHotkeys(c, removeHotkey(effectiveHotkeys(c, prefs.hotkeys), text));
  }

  // ---- スラッシュコマンドの名前（別名） ----

  /** 名前を編集しているコマンド（ID）と、入力中の名前・エラー */
  let slashEditing = $state<string | null>(null);
  let slashDraft = $state('');
  let slashError = $state<string | null>(null);

  function startSlashEdit(c: AppCommand) {
    stopRecording();
    slashEditing = c.id;
    slashDraft = effectiveSlash(c, prefs.slashNames) ?? '';
    slashError = null;
  }

  function stopSlashEdit() {
    slashEditing = null;
    slashError = null;
  }

  function saveSlash(c: AppCommand) {
    const current = effectiveSlash(c, prefs.slashNames) ?? '';
    // いま使われている名前（登録されているスラッシュコマンド）。自分の今の名前は除く
    const taken = slashCommands.list.map((x) => x.name).filter((n) => n !== current);
    const r = checkSlashAlias(slashDraft, { original: c.slash, taken });
    if (!r.ok) {
      slashError = r.error;
      return;
    }
    prefs.setSlashAlias(c.id, r.alias);
    stopSlashEdit();
  }

  /** 別名を付けているか */
  function hasSlashAlias(c: AppCommand): boolean {
    return Object.hasOwn(prefs.slashNames, c.id);
  }
</script>

<svelte:window onkeydowncapture={onRecordKey} />

<Section title="ホットキー" class="hotkey-settings">
  <p class="muted hotkey-settings-note">
    ＋ を押してから、追加したいキーを押します（Esc で取り消し）。キーの右の × で外せます。{#if paletteHotkey}コマンドパレット（{paletteHotkey}）からも実行できます。{/if}この設定はほかの端末とも共有されます
  </p>
  {#each commands as c (c.id)}
    {@const hotkeys = effectiveHotkeys(c, prefs.hotkeys)}
    {@const same = conflicts.get(c.id)}
    <div class="hotkey-settings-command" class:hotkey-settings-command-conflict={!!same}>
      <SettingRow name={c.name} description={c.source} icon={c.icon} class="hotkey-settings-row">
        {#snippet control()}
          {#each hotkeys as hk (hk)}
            <kbd class="kbd hotkey-settings-chip">
              {formatHotkey(hk)}
              <button type="button" class="hotkey-settings-chip-remove" aria-label={`${formatHotkey(hk)} を外す`} onclick={() => removeKey(c, hk)}>
                <X size={12} />
              </button>
            </kbd>
          {:else}
            <span class="muted hotkey-settings-none">なし</span>
          {/each}
          {#if recording === c.id}
            <span class="hotkey-settings-recording">キーを押してください…</span>
          {/if}
          <IconButton
            class="hotkey-settings-reset"
            label="既定に戻す"
            title="既定に戻す"
            icon={RotateCcw}
            iconSize={16}
            disabled={!isHotkeyCustomized(c, prefs.hotkeys)}
            onclick={() => prefs.setHotkeys(c.id, null)}
          />
          <IconButton
            class="hotkey-settings-add"
            label={`${c.name} のホットキーを追加`}
            title="ホットキーを追加"
            icon={Plus}
            iconSize={16}
            active={recording === c.id}
            onclick={() => (recording === c.id ? stopRecording() : startRecording(c))}
            onblur={() => recording === c.id && stopRecording()}
          />
        {/snippet}
      </SettingRow>
      {#if c.slash}
        {@const slash = effectiveSlash(c, prefs.slashNames)}
        {#if slashEditing === c.id}
          <form
            class="hotkey-settings-slash-form"
            onsubmit={(e) => {
              e.preventDefault();
              saveSlash(c);
            }}
          >
            <span class="muted">/</span>
            <TextInput
              class="hotkey-settings-slash-input"
              bind:value={slashDraft}
              maxlength={32}
              autocomplete="off"
              spellcheck={false}
              aria-label={`${c.name} のスラッシュコマンド名`}
              onkeydown={(e) => {
                if (e.key === 'Escape') stopSlashEdit();
              }}
            />
            <IconButton type="submit" label="保存" class="hotkey-settings-slash-save"><Check size={16} /></IconButton>
            <IconButton label="キャンセル" class="hotkey-settings-slash-cancel" onclick={stopSlashEdit}><X size={16} /></IconButton>
          </form>
          {#if slashError}<p class="hotkey-settings-slash-error">{slashError}</p>{/if}
        {:else}
          <div class="hotkey-settings-slash">
            <span class="muted">スラッシュコマンド /{slash}</span>
            <IconButton label={`${c.name} のスラッシュコマンド名を変える`} class="hotkey-settings-slash-edit" onclick={() => startSlashEdit(c)}>
              <Pencil size={14} />
            </IconButton>
            {#if hasSlashAlias(c)}
              <IconButton label="元の名前に戻す" class="hotkey-settings-slash-revert" onclick={() => prefs.setSlashAlias(c.id, null)}>
                <RotateCcw size={14} />
              </IconButton>
            {/if}
          </div>
        {/if}
      {/if}
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
  /* 行の右にキーを並べる。各キーの中の × で外す */
  .hotkey-settings-command :global(.hotkey-settings-row .setting-row-control) {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 4px;
  }
  .hotkey-settings-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .hotkey-settings-chip-remove {
    display: inline-grid;
    place-items: center;
    padding: 0;
    border: none;
    background: none;
    color: inherit;
    cursor: pointer;
    opacity: 0.7;
  }
  .hotkey-settings-chip-remove:hover {
    opacity: 1;
  }
  .hotkey-settings-none,
  .hotkey-settings-recording {
    font-size: 13px;
  }
  /* 記録中は、キーを待っていることがわかるようにアクセントの色にする */
  .hotkey-settings-recording {
    color: var(--accent);
  }
  /* 押せないときは隠す（位置はそろえたまま） */
  .hotkey-settings-command :global(.hotkey-settings-reset:disabled) {
    visibility: hidden;
  }
  /* スラッシュコマンドの名前（別名）の行 */
  .hotkey-settings-slash,
  .hotkey-settings-slash-form {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px;
    margin: 2px 0 0 4px;
    font-size: 13px;
  }
  .hotkey-settings-slash-form :global(.hotkey-settings-slash-input) {
    width: 160px;
  }
  .hotkey-settings-slash-error {
    margin: 2px 0 0 4px;
    font-size: 13px;
    color: var(--danger);
  }
</style>
