<script lang="ts">
  import Pencil from '@lucide/svelte/icons/pencil';
  import Check from '@lucide/svelte/icons/check';
  import X from '@lucide/svelte/icons/x';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import IconButton from '@3pino/ui-kit-web/IconButton.svelte';
  import TextInput from '@3pino/ui-kit-web/TextInput.svelte';
  import HotkeySettings, { type HotkeyItem } from '@3pino/app-kit-web/settings/HotkeySettings.svelte';
  import { findConflicts } from '@3pino/app-kit-web/core/hotkeyBook';
  import {
    addHotkey,
    commandList,
    defaultHotkeys,
    effectiveHotkeys,
    effectiveSlash,
    filterCommands,
    hotkeyOverride,
    isHotkeyCustomized,
    removeHotkey,
    type AppCommand,
  } from '../lib/commands.svelte';
  import { commandHost } from '../lib/commandHost.svelte';
  import { formatHotkey, HOTKEY_OPTIONS } from '../lib/plugins/hotkey';
  import { checkSlashAlias } from '../lib/slashAlias';
  import { slashCommands } from '../lib/slashCommands.svelte';
  import { prefs } from '../lib/stores/prefs.svelte';

  // 設定の「操作」→「ホットキー」（デスクトップのみ）。画面の部品は kit の HotkeySettings。
  // ここでは、このアプリの操作の一覧・保存（prefs.hotkeys）・文言と、スラッシュコマンドの名前（別名）の行（rowExtra）だけを持つ。

  /** 本体のもの → プラグインのもの、それぞれ名前順 */
  const commands = $derived(filterCommands(commandList(), ''));
  const items = $derived<HotkeyItem[]>(commands.map((c) => ({ id: c.id, name: c.name, description: c.source, icon: c.icon })));
  const conflicts = $derived(
    findConflicts(
      commands.map((c) => ({ id: c.id, defaults: defaultHotkeys(c) })),
      prefs.hotkeys,
      HOTKEY_OPTIONS,
    ),
  );

  const byId = (id: string): AppCommand | undefined => commands.find((x) => x.id === id);

  /** 一覧を保存する。既定と同じなら設定を消す（既定が変わったときに追従する） */
  function setHotkeys(c: AppCommand, list: string[]) {
    prefs.setHotkeys(c.id, hotkeyOverride(c, list));
  }

  // ---- スラッシュコマンドの名前（別名） ----

  /** 名前を編集しているコマンド（ID）と、入力中の名前・エラー */
  let slashEditing = $state<string | null>(null);
  let slashDraft = $state('');
  let slashError = $state<string | null>(null);

  function startSlashEdit(c: AppCommand) {
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

<HotkeySettings
  commands={items}
  keys={(id) => {
    const c = byId(id);
    return c ? effectiveHotkeys(c, prefs.hotkeys) : [];
  }}
  isCustom={(id) => {
    const c = byId(id);
    return c ? isHotkeyCustomized(c, prefs.hotkeys) : false;
  }}
  {conflicts}
  allNames={(id) => byId(id)?.name ?? id}
  add={(id, k) => {
    const c = byId(id);
    if (c) setHotkeys(c, addHotkey(effectiveHotkeys(c, prefs.hotkeys), k));
  }}
  remove={(id, k) => {
    const c = byId(id);
    if (c) setHotkeys(c, removeHotkey(effectiveHotkeys(c, prefs.hotkeys), k));
  }}
  reset={(id) => prefs.setHotkeys(id, null)}
  onrecording={(on) => (commandHost.recording = on)}
  hotkeys={HOTKEY_OPTIONS}
  options={{
    mouse: false,
    escapeCancels: true,
    labels: {
      add: (name) => `${name} のホットキーを追加`,
      reset: () => '既定に戻す',
      remove: (_name, key) => `${formatHotkey(key)} を外す`,
    },
    conflictText: (clashes) => `「${[...new Set(clashes.flatMap((x) => x.names))].join('」「')}」と同じキーです`,
  }}
>
  {#snippet rowExtra(item)}
    {@const c = byId(item.id)}
    {#if c?.slash}
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
  {/snippet}
</HotkeySettings>

<style>
  /* スラッシュコマンドの名前（別名）の行 */
  .hotkey-settings-slash,
  .hotkey-settings-slash-form {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1);
    margin: var(--space-1) 0 0 var(--space-2);
    font-size: var(--fs-sm);
  }
  .hotkey-settings-slash-form :global(.hotkey-settings-slash-input) {
    width: 160px;
  }
  .hotkey-settings-slash-error {
    margin: var(--space-1) 0 0 var(--space-2);
    font-size: var(--fs-sm);
    color: var(--danger);
  }
</style>
