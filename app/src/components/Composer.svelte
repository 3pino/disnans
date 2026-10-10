<script lang="ts">
  import Plus from '@lucide/svelte/icons/plus';
  import Send from '@lucide/svelte/icons/send';
  import X from '@lucide/svelte/icons/x';
  import Search from '@lucide/svelte/icons/search';
    import FileIcon from '@lucide/svelte/icons/file';
  import Puzzle from '@lucide/svelte/icons/puzzle';
  import BellOff from '@lucide/svelte/icons/bell-off';
  import MessageInput from './MessageInput.svelte';
  import ReplyBar from './ReplyBar.svelte';
  import IconButton from './ui/IconButton.svelte';
  import Menu from './ui/Menu.svelte';
  import MenuItem from './ui/MenuItem.svelte';
  import { tick, untrack } from 'svelte';
  import { messageSearch } from '../lib/stores/search.svelte';
  import { client } from '../lib/stores/client.svelte';
  import { prefs } from '../lib/stores/prefs.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { reply } from '../lib/stores/reply.svelte';
  import { draftKey, loadDraft, saveDraft } from '../lib/drafts';
  import ImageCropDialog from './ImageCropDialog.svelte';
  import { readImageInfo, canCropImage, type CropRect, type ImageInfo } from '../lib/imageCrop';
  import { shareInbox } from '../lib/stores/shareInbox.svelte';
  import { composerMenuAvailable, composerMenuItems, type ComposerMenuItem } from '../lib/composerMenu';
  import { parseSlashInput, runSlashCommand } from '../lib/slashCommands.svelte';
  import { formatSize } from '../lib/format';
  import { MAX_BODY } from '../lib/errors';
  import { isSilentSwipe, sendButtonLift, swipeUpLift } from '../lib/silentSend';

  let { threadId, placeholder }: { threadId: string | null; placeholder: string } = $props();

  /** 添付するファイル。送るまでアップロードしない（手元に File を持つだけ） */
  type Staged = {
    key: number;
    file: File;
    preview: string | null;
    /** 寸法など（画像のときだけ。読めなければ null） */
    info: ImageInfo | null;
    /** 送る前に切り抜く範囲（null は全体） */
    crop: CropRect | null;
  };

  let input: MessageInput | undefined = $state();
  let fileEl: HTMLInputElement | undefined = $state();
  let staged = $state<Staged[]>([]);
  /** 切り抜く範囲を選んでいる画像 */
  let cropping = $state<Staged | null>(null);
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

  /** 検索モード（メインチャットの入力欄だけ）。通常の入力欄は隠すだけにして、下書きと添付を残す */
  const searching = $derived(threadId === null && ui.searchOpen);
  let searchEl: HTMLInputElement | undefined = $state();

  // 検索モードに入ったとき、もう一度コマンドを実行したときに、検索欄へフォーカスする
  $effect(() => {
    void ui.searchFocusTick;
    if (!searching) return;
    void tick().then(() => searchEl?.focus());
  });

  function onsearchkeydown(e: KeyboardEvent) {
    // IME 変換中の Esc・Enter は変換の操作なので触らない
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSearch();
    }
  }

  function closeSearch() {
    ui.closeSearch();
    // 通常の入力欄に戻ったら、続きを書けるようにフォーカスする
    void tick().then(() => input?.focus());
  }

  const canSend = $derived((hasText || staged.length > 0) && client.ready);

  /** 切り抜きできる画像か（寸法が読めて、アニメーションでないもの） */
  function croppable(s: Staged): boolean {
    return canCropImage(s.info);
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

  // 「＋」メニューの項目。並び順と出す項目は利用者の設定（設定 > 一般 > ＋メニュー）
  const actions = $derived(
    composerMenuItems(
      composerMenuAvailable(() => fileEl?.click()).filter((a) => !a.when || a.when({ threadId })),
      prefs.composerMenu,
    ).map((x) => x.entry),
  );

  async function runAction(a: ComposerMenuItem) {
    menuOpen = false;
    try {
      await a.run({ threadId });
    } catch (e) {
      ui.toast(`${a.label}: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }

  /** 添付に加える（アップロードは送るときに行う） */
  export function addFiles(files: File[]) {
    for (const file of files) {
      const key = ++seq;
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      staged.push({ key, file, preview, info: null, crop: null });
      // 寸法は、大きさを選ぶときとサムネイルの表示のために、先に読んでおく
      void readImageInfo(file).then((info) => {
        const s = staged.find((x) => x.key === key);
        if (s) s.info = info;
      });
    }
    input?.focus();
  }

  // 返信先を選んだら、すぐ入力できるように入力欄にフォーカスする
  $effect(() => {
    if (reply.get(threadId)) untrack(() => input?.focus());
  });

  export function focus() {
    input?.focus();
  }

  function removeStaged(s: Staged) {
    if (s.preview) URL.revokeObjectURL(s.preview);
    if (cropping?.key === s.key) cropping = null;
    staged = staged.filter((x) => x.key !== s.key);
  }

  /** silent は通知を送らない（送信ボタンを上へスワイプして送ったとき） */
  function submit(silent = false) {
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
    client.sendMessage({ threadId, body, files: staged.map((s) => ({ file: s.file, crop: s.crop })), replyTo: reply.get(threadId), silent });
    reply.clear(threadId);
    input.clear();
    hasText = false;
    if (key) saveDraft(key, '');
    // 一覧用の見本の URL は、ここで破棄する（送るファイルは client が持つ）
    for (const s of staged) if (s.preview) URL.revokeObjectURL(s.preview);
    staged = [];
  }

  /** 送信ボタンを押したまま上へなぞっている量（px）。0 なら押しているだけ */
  let sendLift = $state(0);
  let sendGesture: { id: number; startY: number } | null = null;
  /** 直前の操作で silent 送信した（続く click では送らない） */
  let sendSilentDone = false;

  function onsendpointerdown(e: PointerEvent) {
    if (e.button !== 0) return;
    sendSilentDone = false;
    sendGesture = { id: e.pointerId, startY: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onsendpointermove(e: PointerEvent) {
    if (!sendGesture || e.pointerId !== sendGesture.id) return;
    sendLift = swipeUpLift(sendGesture.startY, e.clientY);
  }

  function onsendpointerup(e: PointerEvent) {
    if (!sendGesture || e.pointerId !== sendGesture.id) return;
    const lift = swipeUpLift(sendGesture.startY, e.clientY);
    sendGesture = null;
    sendLift = 0;
    // しきい値に届いたら通知なしで送る。届かなければ、続く click で通常の送信になる
    if (isSilentSwipe(lift)) {
      sendSilentDone = true;
      submit(true);
    }
  }

  function onsendpointercancel(e: PointerEvent) {
    if (!sendGesture || e.pointerId !== sendGesture.id) return;
    sendGesture = null;
    sendLift = 0;
  }

  function onsendclick() {
    // 上へのスワイプで送ったあとの click は無視する（二重に送らない）
    if (sendSilentDone) {
      sendSilentDone = false;
      return;
    }
    submit();
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
      if (msgs[i].author_id === me && !msgs[i].bot) {
        ui.editing = msgs[i].id;
        return;
      }
    }
  }
</script>

<div class="composer" class:composer-in-thread={threadId !== null}>
  {#if !searching}
    <ReplyBar {threadId} />
  {/if}

  {#if staged.length > 0 && !searching}
    <div class="composer-upload-tray">
      {#each staged as s (s.key)}
        <div class="composer-upload" title={s.file.name}>
          {#if s.preview}
            {#if croppable(s)}
              <!-- 画像は、タップすると切り抜く範囲を選べる -->
              <button type="button" class="composer-upload-thumb" aria-label="{s.file.name} を切り抜く" onclick={() => (cropping = s)}>
                <img class="composer-upload-preview" src={s.preview} alt="" />
              </button>
            {:else}
              <img class="composer-upload-preview" src={s.preview} alt="" />
            {/if}
            {#if s.crop}<span class="composer-upload-badge">切り抜き</span>{/if}
          {:else}
            <div class="composer-upload-file-icon"><FileIcon size={20} /><span>{formatSize(s.file.size)}</span></div>
          {/if}
          <span class="composer-upload-name">{s.file.name}</span>
          <button type="button" class="composer-upload-remove" aria-label="取り消す" onclick={() => removeStaged(s)}><X size={12} /></button>
        </div>
      {/each}
    </div>
  {/if}

  {#if searching}
    <div class="composer-row composer-search" role="search">
      <span class="composer-search-icon" aria-hidden="true"><Search size={18} /></span>
      <input
        class="input composer-search-input"
        bind:this={searchEl}
        value={messageSearch.query}
        oninput={(e) => messageSearch.setQuery(e.currentTarget.value)}
        placeholder="メッセージを検索（空白で区切ると、すべて含むものを探します）"
        aria-label="メッセージを検索"
        autocomplete="off"
        spellcheck="false"
        onkeydown={onsearchkeydown}
      />
      <IconButton class="composer-search-close" label="検索を閉じる" onclick={closeSearch}><X size={18} /></IconButton>
    </div>
  {/if}

  <div class="composer-row" class:composer-row-hidden={searching}>
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
          {#each actions as a (a.id)}
            <MenuItem class="composer-menu-item" icon={a.icon ?? Puzzle} onclick={() => void runAction(a)}>
              {a.label}
            </MenuItem>
          {:else}
            <p class="muted composer-menu-empty">表示する項目がありません</p>
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

    <button
      type="button"
      class="composer-send"
      class:composer-send-lifting={sendLift > 0}
      disabled={!canSend}
      aria-label="送信"
      style:transform={sendLift > 0 ? `translateY(${-sendButtonLift(sendLift)}px)` : null}
      onpointerdown={onsendpointerdown}
      onpointermove={onsendpointermove}
      onpointerup={onsendpointerup}
      onpointercancel={onsendpointercancel}
      onclick={onsendclick}
    >
      {#if sendLift > 0}
        <BellOff size={18} />
        <!-- 上へスワイプ中。しきい値に届くと、離したときに通知なしで送る -->
        <span class="composer-send-hint" class:composer-send-hint-ready={isSilentSwipe(sendLift)}>通知なしで送信</span>
      {:else}
        <Send size={18} />
      {/if}
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

  {#if cropping && cropping.info}
    {@const target = cropping}
    <ImageCropDialog
      file={target.file}
      info={target.info!}
      value={target.crop}
      onpick={(crop) => {
        target.crop = crop;
        cropping = null;
      }}
      onclose={() => (cropping = null)}
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
  .composer-row-hidden {
    display: none;
  }
  .composer-search {
    align-items: center;
    padding: 4px 6px 4px 12px;
  }
  .composer-search-icon {
    display: grid;
    place-items: center;
    color: var(--text-muted);
    flex: none;
  }
  /* 枠は .composer-row が描くので、入力そのものは枠なしにする */
  .composer-search > .composer-search-input {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    box-shadow: none;
    outline: none;
  }
  .composer-search > :global(.icon-btn) {
    margin-bottom: 0;
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
  .composer-menu-empty {
    margin: 0;
    padding: 8px 10px;
    font-size: 13px;
  }
  .composer-send {
    position: relative;
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
    /* 上へのスワイプ（通知なしで送る）を指で追えるように、ブラウザーの処理（スクロール）を止める */
    touch-action: none;
    transition:
      opacity 0.12s,
      transform 0.12s;
  }
  .composer-send:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .composer-send-lifting {
    box-shadow: var(--shadow);
  }
  /* 上へスワイプ中の小さなラベル（ボタンの上に出す） */
  .composer-send-hint {
    position: absolute;
    right: 0;
    bottom: calc(100% + 10px);
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    background: var(--surface);
    box-shadow: var(--shadow);
    color: var(--text-muted);
    font-size: 12px;
    line-height: 1.4;
    white-space: nowrap;
    pointer-events: none;
  }
  .composer-send-hint-ready {
    color: var(--accent);
    font-weight: 600;
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
