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
  import { onMount, tick, untrack } from 'svelte';
  import { messageSearch } from '../lib/stores/search.svelte';
  import { client } from '../lib/stores/client.svelte';
  import { prefs } from '../lib/stores/prefs.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { reply } from '../lib/stores/reply.svelte';
  import { draftLocation, loadDraft, loadDraftAt, registerDraftFlusher, saveDraftAt, type DraftLocation } from '../lib/drafts';
  import { getServerUrl } from '../lib/config';
  import { getDesktopSharedStorage, isDesktopStorageSupported } from '../lib/desktopStorage';
  import ImageCropDialog from './ImageCropDialog.svelte';
  import CameraCapture from './CameraCapture.svelte';
  import AttachPanel from './AttachPanel.svelte';
  import { attachPanel } from '../lib/stores/attachPanel.svelte';
  import { cameraRequest } from '../lib/stores/cameraRequest.svelte';
  import { isAndroid } from '../lib/platform';
  import { type RecentImage } from '../lib/recentImages';
  import { readImageInfo, canCropImage, type CropRect, type ImageInfo } from '../lib/imageCrop';
  import { shareInbox } from '../lib/stores/shareInbox.svelte';
  import { composerMenuAvailable, composerMenuItems, type ComposerMenuItem } from '../lib/composerMenu';
  import { parseSlashInput, runSlashCommand } from '../lib/slashCommands.svelte';
  import { formatSize } from '../lib/format';
  import { MAX_BODY } from '../lib/errors';
  import { isSilentSwipe, sendButtonLift, swipeUpLift } from '../lib/silentSend';

  let { placeholder }: { placeholder: string } = $props();

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

  /** 下書きを保存する場所（接続先・ユーザー・メインチャット/スレッドごと）。 */
  const desktopShared = isDesktopStorageSupported() ? getDesktopSharedStorage() : null;
  const draftTarget = $derived(client.me ? draftLocation(getServerUrl(), client.me.id) : null);
  const draftIdentity = $derived(draftTarget
    ? JSON.stringify([draftTarget.serverUrl, draftTarget.userId, draftTarget.place])
    : null);
  const draftId = $derived(draftTarget ? (desktopShared ? draftIdentity : draftTarget.legacyKey) : null);
  let loadedDraft = $state<{ identity: string; text: string; failed?: boolean } | null>(null);
  let draftLoadAttempt = $state(0);
  let draftLoadPromise: Promise<void> | null = null;
  const draftWarningTimes = new Map<string, number>();

  function warnDraftSave(identity: string, message: string) {
    const now = Date.now();
    const previous = draftWarningTimes.get(identity);
    if (previous !== undefined && now - previous < 10_000) return;
    draftWarningTimes.set(identity, now);
    ui.toast(message, 'error');
  }

  onMount(() => {
    if (!desktopShared) return;
    return registerDraftFlusher(async () => {
      await tick();
      await draftLoadPromise;
      await tick();
      if (staged.length > 0) throw new Error('未送信の添付ファイルがあります');
      if (running) throw new Error('コマンド実行中です');
      if (shareInbox.files.length > 0 || shareInbox.text !== '') throw new Error('未処理の共有データがあります');
      const target = draftTarget;
      if (!target || !input) {
        if (loadedDraft?.identity === draftIdentity && loadedDraft.failed) throw new Error('下書きを読み込めていません');
        return;
      }
      const result = await saveDraftAt(target, input.getRawBody(), desktopShared);
      if (result.status !== 'shared') throw new Error('A draft was not saved to shared storage');
    });
  });

  function retryDraftLoad() {
    draftLoadAttempt += 1;
  }

  // On desktop, do not mount an empty editor before the async shared/legacy migration read completes.
  $effect(() => {
    const target = draftTarget;
    const identity = draftIdentity;
    void draftLoadAttempt;
    if (!desktopShared) return;
    loadedDraft = null;
    if (!target || !identity) return;
    let current = true;
    draftLoadPromise = loadDraftAt(target, desktopShared).then((text) => {
      if (current) loadedDraft = { identity, text };
    }).catch((error) => {
      if (!current) return;
      loadedDraft = { identity, text: '', failed: true };
      ui.toast(
        `下書きを読み込めませんでした。再試行してください: ${error instanceof Error ? error.message : String(error)}`,
        'error',
        { label: '再試行', run: retryDraftLoad },
        60_000,
      );
    });
    return () => { current = false; };
  });

  const draftText = $derived(desktopShared
    ? (loadedDraft?.identity === draftIdentity ? loadedDraft.text : '')
    : (draftId ? loadDraft(draftId) : ''));
  const draftReady = $derived(!desktopShared || (!!draftIdentity && loadedDraft?.identity === draftIdentity && !loadedDraft.failed));

  function persistDraft(target: NonNullable<typeof draftTarget>, body: string) {
    const identity = JSON.stringify([target.serverUrl, target.userId, target.place]);
    void saveDraftAt(target, body, desktopShared ?? undefined).then((result) => {
      if (result.status === 'legacy-fallback') {
        warnDraftSave(identity, '下書きはデバイス内だけに保存され、共有ファイルには保存されていません。');
      } else if (result.status === 'superseded') {
        warnDraftSave(identity, '下書きが別のクライアントで更新されました。入力中の文章はそのまま残しています。');
      }
    }).catch((error) => {
      warnDraftSave(identity, `下書きを保存できませんでした。入力中の文章は残しています: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  $effect(() => {
    const t = draftText;
    untrack(() => (hasText = t.trim() !== ''));
  });

  /** 検索モード（メインチャットの入力欄だけ）。通常の入力欄は隠すだけにして、下書きと添付を残す */
  const searching = $derived(ui.searchOpen);
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

  // 「写真を撮る」（カメラのモーダル）。依頼を取り出したら開く。撮った写真は添付に加える
  let cameraOpen = $state(false);
  /** Android は標準のカメラアプリを開く（隠しの input の capture）。戻ると撮った写真が添付に入る */
  let cameraEl: HTMLInputElement | undefined = $state();
  let imageEl: HTMLInputElement | undefined = $state();
  function takePhoto() {
    if (isAndroid()) cameraEl?.click();
    else cameraOpen = true;
  }
  $effect(() => {
    if (!draftReady) return;
    if (cameraRequest.pending) untrack(() => (cameraRequest.take() ? takePhoto() : undefined));
  });

  function onpanelclipboard(file: File) {
    attachPanel.hide();
    addFiles([file]);
  }

  function onpanelrecent(image: RecentImage) {
    attachPanel.hide();
    void image.load().then(
      (file) => addFiles([file]),
      (e: unknown) => ui.toast(`添付できませんでした: ${e instanceof Error ? e.message : String(e)}`, 'error'),
    );
  }

  /** 隠しの input で選んだものを添付に加える（同じものを続けて選べるよう、値は空にする） */
  function onpicked(e: Event & { currentTarget: HTMLInputElement }) {
    const files = [...(e.currentTarget.files ?? [])];
    e.currentTarget.value = '';
    attachPanel.hide();
    if (files.length) addFiles(files);
  }

  // 共有で受け取ったものを、メインチャットの入力欄が拾う
  $effect(() => {
    if (!draftReady || !input) return;
    if (shareInbox.files.length === 0 && shareInbox.text === '') return;
    untrack(() => takeShared());
  });

  function takeShared() {
    const got = shareInbox.take();
    // チャットを見せる。モバイルでパネルが開いていれば閉じる（パネルがチャットを覆うため）
    ui.showMain();
    if (got.text) input?.appendText(got.text);
    if (got.files.length > 0) addFiles(got.files);
    input?.focus();
  }

  // 「＋」メニューの項目。並び順と出す項目は利用者の設定（設定 > 一般 > ＋メニュー）
  const actions = $derived(
    composerMenuItems(
      composerMenuAvailable(() => fileEl?.click()).filter((a) => !a.when || a.when()),
      prefs.composerMenu,
    ).map((x) => x.entry),
  );

  async function runAction(a: ComposerMenuItem) {
    menuOpen = false;
    try {
      await a.run();
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
    if (reply.get()) untrack(() => input?.focus());
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
    const target = draftTarget;
    // コマンドは送らずに実行する。添付はそのまま残す
    if (parsed.kind === 'command') {
      if (client.ready) void runCommand(parsed.name, parsed.args, target, input, draftIdentity, input.getRawBody());
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
    client.sendMessage({ body, files: staged.map((s) => ({ file: s.file, crop: s.crop })), replyTo: reply.get(), silent });
    reply.clear();
    input.clear();
    hasText = false;
    if (target) persistDraft(target, '');
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

  async function runCommand(
    name: string,
    args: string,
    target: DraftLocation | null,
    editor: MessageInput | undefined,
    identity: string | null,
    submittedBody: string,
  ) {
    running = true;
    try {
      await runSlashCommand(name, args);
      const stillSameEditor = !!editor && input === editor && draftIdentity === identity;
      if (stillSameEditor && editor.getRawBody() === submittedBody) {
        editor.clear();
        hasText = false;
        if (target) persistDraft(target, '');
      }
      // If the editor changed, retain its draft: it may contain newer input typed before switching.
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      running = false;
    }
  }

  function editLast() {
    const me = client.me?.id;
    if (!me) return;
    const msgs = client.timeline().messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].author_id === me && !msgs[i].bot) {
        ui.editing = msgs[i].id;
        return;
      }
    }
  }
</script>

<div class="composer">
  {#if !searching}
    <ReplyBar />
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

  {#if attachPanel.open}
    <AttachPanel
      oncamera={() => {
        attachPanel.hide();
        takePhoto();
      }}
      onimage={() => {
        attachPanel.hide();
        imageEl?.click();
      }}
      onfile={() => {
        attachPanel.hide();
        fileEl?.click();
      }}
      onrecent={onpanelrecent}
      onclipboard={onpanelclipboard}
      onclose={() => attachPanel.hide()}
    />
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

    {#if draftReady}
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
            const target = draftTarget;
            if (draftId && target && input) persistDraft(target, input.getRawBody());
          }}
        />
      {/key}
    {/if}

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

  <input bind:this={fileEl} type="file" class="composer-file-input" multiple hidden onchange={onpicked} />
  <input bind:this={imageEl} type="file" accept="image/*" class="composer-file-input" multiple hidden onchange={onpicked} />
  <!-- Android の標準カメラ（Tauri が capture を ACTION_IMAGE_CAPTURE にする。accept は正確に image/*） -->
  <input bind:this={cameraEl} type="file" accept="image/*" capture="environment" class="composer-file-input" hidden onchange={onpicked} />

  {#if cameraOpen}
    <CameraCapture
      onphoto={(file) => {
        cameraOpen = false;
        addFiles([file]);
      }}
      onclose={() => (cameraOpen = false)}
    />
  {/if}

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
    padding: 0 var(--space-7) 14px;
    padding-bottom: max(14px, env(safe-area-inset-bottom));
  }
  /* 補完の候補は、入力欄だけでなく、この枠（＋ボタンから送信ボタンまで）の幅いっぱいに出す */
  .composer-row {
    position: relative;
    --message-input-suggest-inset: -1px;
    display: flex;
    align-items: flex-end;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    transition:
      border-color 0.12s,
      background-color 0.12s;
  }
  .composer-row-hidden {
    display: none;
  }
  .composer-search {
    align-items: center;
    padding: var(--space-2) var(--space-3) var(--space-2) var(--space-6);
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
  /* メニューの見た目は .menu（@3pino/design-system の components.css）。ここでは ＋ ボタンの上に出す位置だけを決める */
  .composer-plus > :global(.composer-menu) {
    position: absolute;
    bottom: calc(100% + 8px);
    left: -4px;
  }
  .composer-menu-empty {
    margin: 0;
    padding: var(--space-4) var(--space-5);
    font-size: var(--fs-sm);
  }
  .composer-send {
    position: relative;
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    margin-bottom: var(--space-1);
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
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-sm);
    background: var(--surface);
    box-shadow: var(--shadow);
    color: var(--text-muted);
    font-size: var(--fs-sm);
    line-height: var(--lh-tight);
    white-space: nowrap;
    pointer-events: none;
  }
  .composer-send-hint-ready {
    color: var(--accent);
    font-weight: var(--fw-semibold);
  }
  .composer-upload-tray {
    display: flex;
    gap: var(--space-4);
    overflow-x: auto;
    padding: var(--space-2) var(--space-1) var(--space-4);
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
    padding: 1px var(--space-3);
    border-radius: var(--radius-pill);
    background: color-mix(in oklch, var(--bg) 80%, transparent);
    color: var(--text);
    font-size: var(--fs-xs);
    line-height: var(--lh-body);
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
    gap: var(--space-1);
    color: var(--text-muted);
    font-size: var(--fs-xs);
  }
  .composer-upload-name {
    display: block;
    padding: var(--space-1) var(--space-3) var(--space-2);
    font-size: var(--fs-xs);
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
      padding: 0 var(--space-4) var(--space-4);
    }
  }
</style>
