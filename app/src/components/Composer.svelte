<script lang="ts">
  import Plus from '@lucide/svelte/icons/plus';
  import Send from '@lucide/svelte/icons/send';
  import X from '@lucide/svelte/icons/x';
  import Paperclip from '@lucide/svelte/icons/paperclip';
  import FileIcon from '@lucide/svelte/icons/file';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import Puzzle from '@lucide/svelte/icons/puzzle';
  import MessageInput from './MessageInput.svelte';
  import IconButton from './ui/IconButton.svelte';
  import Menu from './ui/Menu.svelte';
  import MenuItem from './ui/MenuItem.svelte';
  import { untrack } from 'svelte';
  import { client } from '../lib/stores/client.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { draftKey, loadDraft, saveDraft } from '../lib/drafts';
  import { uploadFile } from '../lib/api';
  import type { Attachment } from '../lib/protocol/Attachment';
  import { composerActions, type BuiltinComposerAction, type ComposerAction } from '../lib/composerActions';
  import { parseSlashInput, runSlashCommand } from '../lib/slashCommands.svelte';
  import { formatSize } from '../lib/format';
  import { MAX_BODY } from '../lib/errors';

  let { threadId, placeholder }: { threadId: string | null; placeholder: string } = $props();

  type Upload = {
    key: number;
    file: File;
    preview: string | null;
    progress: number;
    attachment: Attachment | null;
    error: string | null;
    abort: () => void;
  };

  let input: MessageInput | undefined = $state();
  let fileEl: HTMLInputElement | undefined = $state();
  let uploads = $state<Upload[]>([]);
  let menuOpen = $state(false);
  let hasText = $state(false);
  /** コマンドを実行中（終わるまで次を送らない） */
  let running = $state(false);
  let seq = 0;

  /** 下書きを保存する場所（メインチャット・スレッドごと、ユーザーごと）。ユーザーがまだ分からないときは保存しない */
  const draftId = $derived(client.me ? draftKey(client.me.id, threadId) : null);
  /** 下書きの文章。場所を切り替えたら、その場所の下書きで入力欄を作り直す（{#key} の中） */
  const draftText = $derived(draftId ? loadDraft(draftId) : '');

  $effect(() => {
    const t = draftText;
    untrack(() => (hasText = t.trim() !== ''));
  });

  const uploading = $derived(uploads.some((u) => !u.attachment && !u.error));
  const ready = $derived(uploads.filter((u) => u.attachment));
  const canSend = $derived(!uploading && (hasText || ready.length > 0) && client.ready);

  const builtinActions: BuiltinComposerAction[] = [
    { id: 'file', label: 'ファイルを添付', icon: Paperclip, run: (c) => c.pickFiles() },
  ];
  // 本体の項目のあとに、登録された項目を並べる
  const actions = $derived(
    [...builtinActions.map((a) => ({ ...a, builtin: true as const })), ...composerActions()].filter(
      (a) => !a.when || a.when({ threadId }),
    ),
  );

  async function runAction(a: BuiltinComposerAction | ComposerAction, builtin: boolean) {
    menuOpen = false;
    try {
      if (builtin) (a as BuiltinComposerAction).run({ threadId, pickFiles: () => fileEl?.click() });
      else await (a as ComposerAction).run({ threadId });
    } catch (e) {
      ui.toast(`${a.label}: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }

  export function addFiles(files: File[]) {
    for (const file of files) {
      const key = ++seq;
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      const h = uploadFile(file, (r) => {
        const u = uploads.find((x) => x.key === key);
        if (u) u.progress = r;
      });
      uploads.push({ key, file, preview, progress: 0, attachment: null, error: null, abort: h.abort });
      h.promise.then(
        (a) => {
          const u = uploads.find((x) => x.key === key);
          if (u) {
            u.attachment = a;
            u.progress = 1;
          }
        },
        (e: Error) => {
          const u = uploads.find((x) => x.key === key);
          if (u) u.error = e.message;
        },
      );
    }
    input?.focus();
  }

  export function focus() {
    input?.focus();
  }

  function removeUpload(u: Upload) {
    if (!u.attachment && !u.error) u.abort();
    if (u.preview) URL.revokeObjectURL(u.preview);
    uploads = uploads.filter((x) => x.key !== u.key);
  }

  function submit() {
    if (!input || running) return;
    const parsed = parseSlashInput(input.getBody());
    const key = draftId;
    // コマンドは送らずに実行する。添付はそのまま残す
    if (parsed.kind === 'command') {
      if (client.ready) void runCommand(parsed.name, parsed.args, key);
      return;
    }
    if (!canSend) return;
    const body = parsed.body;
    const attachments = ready.map((u) => u.attachment!);
    if (!body && attachments.length === 0) return;
    if (body.length > MAX_BODY) {
      ui.toast(`メッセージが長すぎます（${body.length} / ${MAX_BODY}文字）`, 'error');
      return;
    }
    client.sendMessage({ threadId, body, attachments });
    input.clear();
    hasText = false;
    if (key) saveDraft(key, '');
    // プレビュー用の blob URL は、仮表示が終わるまで残しておく必要がないので破棄する
    for (const u of uploads) if (u.preview) URL.revokeObjectURL(u.preview);
    uploads = uploads.filter((u) => !u.attachment);
  }

  async function runCommand(name: string, args: string, key: string | null) {
    running = true;
    try {
      await runSlashCommand(name, args, threadId);
      input?.clear();
      hasText = false;
      if (key) saveDraft(key, '');
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      running = false;
    }
  }

  function editLast() {
    const me = client.me?.id;
    if (!me) return;
    const msgs = client.timeline(threadId).messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].author_id === me) {
        ui.editing = msgs[i].id;
        return;
      }
    }
  }
</script>

<div class="composer" class:composer-in-thread={threadId !== null}>
  {#if uploads.length > 0}
    <div class="composer-upload-tray">
      {#each uploads as u (u.key)}
        <div class="composer-upload" class:composer-upload-error={!!u.error} title={u.error ?? u.file.name}>
          {#if u.preview}
            <img class="composer-upload-preview" src={u.preview} alt="" />
          {:else}
            <div class="composer-upload-file-icon"><FileIcon size={20} /><span>{formatSize(u.file.size)}</span></div>
          {/if}
          <span class="composer-upload-name">{u.file.name}</span>
          {#if u.error}
            <span class="composer-upload-error-icon"><CircleAlert size={16} /></span>
          {:else if !u.attachment}
            <div class="composer-upload-progress"><div class="composer-upload-progress-fill" style:width="{Math.round(u.progress * 100)}%"></div></div>
          {/if}
          <button type="button" class="composer-upload-remove" aria-label="取り消す" onclick={() => removeUpload(u)}><X size={12} /></button>
        </div>
      {/each}
    </div>
  {/if}

  <div class="composer-row">
    <div class="composer-plus">
      <IconButton
        class="composer-plus-button"
        active={menuOpen}
        label="その他の操作"
        aria-expanded={menuOpen}
        onclick={() => (menuOpen = !menuOpen)}
      >
        <Plus size={20} />
      </IconButton>
      {#if menuOpen}
        <Menu class="composer-menu" onclose={() => (menuOpen = false)}>
          {#each actions as a (('builtin' in a ? 'builtin:' : '') + a.id)}
            <MenuItem
              class="composer-menu-item"
              icon={a.icon ?? Puzzle}
              onclick={() => void runAction(a, 'builtin' in a)}
            >
              {a.label}
            </MenuItem>
          {/each}
        </Menu>
      {/if}
    </div>

    {#key draftId}
      <MessageInput
        bind:this={input}
        {placeholder}
        commands
        initial={draftText}
        onsubmit={submit}
        onfiles={addFiles}
        onarrowupempty={editLast}
        oninput={(t) => {
          hasText = t.trim().length > 0;
          if (draftId && input) saveDraft(draftId, input.getRawBody());
        }}
      />
    {/key}

    <button type="button" class="composer-send" disabled={!canSend} aria-label="送信" onclick={submit}>
      <Send size={18} />
    </button>
  </div>

  <input
    bind:this={fileEl}
    type="file"
    class="composer-file-input"
    multiple
    hidden
    onchange={(e) => {
      const files = [...(e.currentTarget.files ?? [])];
      e.currentTarget.value = '';
      if (files.length) addFiles(files);
    }}
  />
</div>

<style>
  .composer {
    padding: 0 16px 14px;
    padding-bottom: max(14px, env(safe-area-inset-bottom));
  }
  /* 補完の候補は、入力欄だけでなく、この枠（＋ボタンから送信ボタンまで）の幅いっぱいに出す */
  .composer-row {
    position: relative;
    --message-input-suggest-inset: -1px;
    display: flex;
    align-items: flex-end;
    gap: 4px;
    padding: 4px 6px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    transition:
      border-color 0.12s,
      background-color 0.12s;
  }
  .composer .composer-row > :global(.message-input) {
    position: static;
  }
  /* フォーカス中は青くせず、枠と背景を少し明るくする */
  .composer-row:focus-within {
    border-color: var(--border-focus);
    background: var(--field-focus-bg);
  }
  .composer-row > :global(.icon-btn),
  .composer-plus {
    margin-bottom: 3px;
  }
  .composer-plus {
    position: relative;
  }
  /* メニューの見た目は .menu（app.css）。ここでは ＋ ボタンの上に出す位置だけを決める */
  .composer-plus > :global(.composer-menu) {
    position: absolute;
    bottom: calc(100% + 8px);
    left: -4px;
  }
  .composer-send {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    margin-bottom: 2px;
    border: none;
    border-radius: 10px;
    background: var(--accent);
    color: var(--on-accent);
    flex: none;
    transition: opacity 0.12s;
  }
  .composer-send:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .composer-upload-tray {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding: 4px 2px 8px;
  }
  .composer-upload {
    position: relative;
    flex: none;
    width: 88px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--surface);
    overflow: hidden;
  }
  .composer-upload.composer-upload-error {
    border-color: var(--danger);
  }
  .composer-upload .composer-upload-preview,
  .composer-upload-file-icon {
    display: block;
    width: 100%;
    height: 64px;
    object-fit: cover;
  }
  .composer-upload-file-icon {
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 2px;
    color: var(--text-muted);
    font-size: 11px;
  }
  .composer-upload-name {
    display: block;
    padding: 2px 6px 4px;
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .composer-upload-progress {
    position: absolute;
    left: 0;
    right: 0;
    top: 60px;
    height: 4px;
    background: var(--surface-2);
  }
  .composer-upload-progress .composer-upload-progress-fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.15s;
  }
  .composer-upload-error-icon {
    position: absolute;
    top: 22px;
    left: 34px;
    color: var(--danger);
  }
  .composer-upload-remove {
    position: absolute;
    top: 3px;
    right: 3px;
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: color-mix(in oklch, var(--bg) 80%, transparent);
    color: var(--text);
  }
  @media (max-width: 767px) {
    .composer {
      padding: 0 8px 8px;
    }
    /* スレッドは全画面でボトムナビがないので、ナビゲーションバーの分を空ける */
    .composer.composer-in-thread {
      padding-bottom: max(8px, env(safe-area-inset-bottom));
    }
  }
</style>
