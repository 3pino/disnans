<script lang="ts">
  import Plus from '@lucide/svelte/icons/plus';
  import Send from '@lucide/svelte/icons/send';
  import X from '@lucide/svelte/icons/x';
  import Paperclip from '@lucide/svelte/icons/paperclip';
  import FileIcon from '@lucide/svelte/icons/file';
  import Puzzle from '@lucide/svelte/icons/puzzle';
  import MessageInput from './MessageInput.svelte';
  import IconButton from './ui/IconButton.svelte';
  import Menu from './ui/Menu.svelte';
  import MenuItem from './ui/MenuItem.svelte';
  import { untrack } from 'svelte';
  import { client } from '../lib/stores/client.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { draftKey, loadDraft, saveDraft } from '../lib/drafts';
  import ImageResizeDialog from './ImageResizeDialog.svelte';
  import { readImageInfo, canResizeImage, type ImageInfo } from '../lib/imageResize';
  import { shareInbox } from '../lib/stores/shareInbox.svelte';
  import { composerActions, type BuiltinComposerAction, type ComposerAction } from '../lib/composerActions';
  import { parseSlashInput, runSlashCommand } from '../lib/slashCommands.svelte';
  import { formatSize } from '../lib/format';
  import { MAX_BODY } from '../lib/errors';

  let { threadId, placeholder }: { threadId: string | null; placeholder: string } = $props();

  /** 添付するファイル。送るまでアップロードしない（手元に File を持つだけ） */
  type Staged = {
    key: number;
    file: File;
    preview: string | null;
    /** 寸法など（画像のときだけ。読めなければ null） */
    info: ImageInfo | null;
    /** 送る前に縮小する長辺（null は元のまま） */
    maxEdge: number | null;
  };

  let input: MessageInput | undefined = $state();
  let fileEl: HTMLInputElement | undefined = $state();
  let staged = $state<Staged[]>([]);
  /** 大きさを選んでいる画像 */
  let resizing = $state<Staged | null>(null);
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

  const canSend = $derived((hasText || staged.length > 0) && client.ready);

  /** 大きさを選べる画像か（寸法が読めて、アニメーションでないもの） */
  function resizable(s: Staged): boolean {
    return canResizeImage(s.info);
  }

  // 共有で受け取ったものを、メインチャットの入力欄が拾う（スレッドは対象外）
  $effect(() => {
    if (threadId !== null) return;
    if (shareInbox.files.length === 0 && shareInbox.text === '') return;
    untrack(() => takeShared());
  });

  function takeShared() {
    const got = shareInbox.take();
    // チャットを見せる。モバイルでパネルが開いていれば閉じる（パネルがチャットを覆うため）
    ui.tab = 'chat';
    if (ui.isMobile) ui.closePanel();
    if (got.text) input?.appendText(got.text);
    if (got.files.length > 0) addFiles(got.files);
    input?.focus();
  }

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

  /** 添付に加える（アップロードは送るときに行う） */
  export function addFiles(files: File[]) {
    for (const file of files) {
      const key = ++seq;
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      staged.push({ key, file, preview, info: null, maxEdge: null });
      // 寸法は、大きさを選ぶときとサムネイルの表示のために、先に読んでおく
      void readImageInfo(file).then((info) => {
        const s = staged.find((x) => x.key === key);
        if (s) s.info = info;
      });
    }
    input?.focus();
  }

  export function focus() {
    input?.focus();
  }

  function removeStaged(s: Staged) {
    if (s.preview) URL.revokeObjectURL(s.preview);
    if (resizing?.key === s.key) resizing = null;
    staged = staged.filter((x) => x.key !== s.key);
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
    if (!body && staged.length === 0) return;
    if (body.length > MAX_BODY) {
      ui.toast(`メッセージが長すぎます（${body.length} / ${MAX_BODY}文字）`, 'error');
      return;
    }
    // アップロードと送信は client の仮表示の中で行う。入力欄はすぐ空にする
    client.sendMessage({ threadId, body, files: staged.map((s) => ({ file: s.file, maxEdge: s.maxEdge })) });
    input.clear();
    hasText = false;
    if (key) saveDraft(key, '');
    // 一覧用の見本の URL は、ここで破棄する（送るファイルは client が持つ）
    for (const s of staged) if (s.preview) URL.revokeObjectURL(s.preview);
    staged = [];
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
  {#if staged.length > 0}
    <div class="composer-upload-tray">
      {#each staged as s (s.key)}
        <div class="composer-upload" title={s.file.name}>
          {#if s.preview}
            {#if resizable(s)}
              <!-- 画像は、タップすると大きさを選べる -->
              <button type="button" class="composer-upload-thumb" aria-label="{s.file.name} の大きさを選ぶ" onclick={() => (resizing = s)}>
                <img class="composer-upload-preview" src={s.preview} alt="" />
              </button>
            {:else}
              <img class="composer-upload-preview" src={s.preview} alt="" />
            {/if}
            {#if s.maxEdge !== null}<span class="composer-upload-badge">長辺 {s.maxEdge}</span>{/if}
          {:else}
            <div class="composer-upload-file-icon"><FileIcon size={20} /><span>{formatSize(s.file.size)}</span></div>
          {/if}
          <span class="composer-upload-name">{s.file.name}</span>
          <button type="button" class="composer-upload-remove" aria-label="取り消す" onclick={() => removeStaged(s)}><X size={12} /></button>
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

  {#if resizing && resizing.info}
    {@const target = resizing}
    <ImageResizeDialog
      file={target.file}
      info={target.info!}
      value={target.maxEdge}
      onpick={(maxEdge) => {
        target.maxEdge = maxEdge;
        resizing = null;
      }}
      onclose={() => (resizing = null)}
    />
  {/if}
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
  .composer-upload .composer-upload-thumb {
    display: block;
    width: 100%;
    padding: 0;
    border: none;
    background: none;
    cursor: zoom-in;
  }
  .composer-upload-badge {
    position: absolute;
    left: 4px;
    top: 4px;
    padding: 1px 6px;
    border-radius: 999px;
    background: color-mix(in oklch, var(--bg) 80%, transparent);
    color: var(--text);
    font-size: 10px;
    line-height: 1.5;
    pointer-events: none;
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
