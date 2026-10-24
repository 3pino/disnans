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
  import { onDestroy, onMount, tick, untrack } from 'svelte';
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
  import { prepareUpload, readImageInfo, canCropImage } from '../lib/imageCrop';
  import { uploadFile } from '../lib/api';
  import { discardUpload } from '../lib/transport/files';
  import { ComposerAttachments, type StagedItem } from '../lib/composerAttachments.svelte';
  import { sharedIndex } from '../lib/stores/sharedIndex.svelte';
  import { shareInbox } from '../lib/stores/shareInbox.svelte';
  import { composerMenuAvailable, composerMenuItems, type ComposerMenuItem } from '../lib/composerMenu';
  import { parseSlashInput, runSlashCommand } from '../lib/slashCommands.svelte';
  import { formatSize } from '../lib/format';
  import { MAX_BODY } from '../lib/errors';
  import { isSilentSwipe, sendButtonLift, swipeUpLift } from '../lib/silentSend';

  let { placeholder }: { placeholder: string } = $props();

  let input: MessageInput | undefined = $state();
  let fileEl: HTMLInputElement | undefined = $state();
  /** 添付（アップロードの途中・できた・失敗）。できたものは本文に埋め込まれる（lib/composerAttachments） */
  const attach = new ComposerAttachments({
    prepare: prepareUpload,
    upload: (file, onProgress) => uploadFile(file, onProgress),
    // 投稿前の添付を取り消す（本人の、本文に無いものだけ。消せなくても、24 時間後には掃除で消える）
    discard: (att) =>
      discardUpload(att.id).catch((e: unknown) => {
        console.warn('投稿前の添付を取り消せませんでした', e);
      }),
    insert: (embed) => {
      if (!input) return false;
      input.insertAtCaret(embed);
      return true;
    },
    replace: (from, to) => input?.replaceText(from, to) ?? false,
    unembed: (embed) => {
      input?.replaceText(embed, '');
    },
    mark: (att, on) => sharedIndex.setUnposted(`attachments/${att.file_name}`, on),
    readInfo: readImageInfo,
    preview: (file) => (file.type.startsWith('image/') ? URL.createObjectURL(file) : null),
    revoke: (url) => URL.revokeObjectURL(url),
    toast: (text) => ui.toast(text, 'error'),
  });
  /** 切り抜く範囲を選んでいる画像 */
  let cropping = $state<StagedItem | null>(null);
  let menuOpen = $state(false);
  let hasText = $state(false);
  /** コマンドを実行中（終わるまで次を送らない） */
  let running = $state(false);

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
      if (attach.uploading) throw new Error('アップロード中の添付ファイルがあります');
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

  // 送れるのは、本文があって、アップロードが終わったとき（埋め込みはまだ本文に無いものがある）
  const canSend = $derived(hasText && client.ready && !attach.uploading);

  // 途中のアップロードは中止する（できたものは下書きの本文に埋め込みが残るので消さない）
  onDestroy(() => attach.dispose());
  // 接続先・利用者が変わったら、入力欄の添付を捨てる（消しに行かない: 接続先が変わっているため）
  $effect(() => {
    void draftIdentity;
    untrack(() => attach.forget());
  });

  /** 切り抜きできる画像か（寸法が読めて、アニメーションでないもの） */
  function croppable(s: StagedItem): boolean {
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

  /** 添付に加える。すぐアップロードし、できたら本文に埋め込む */
  export function addFiles(files: File[]) {
    attach.add(files);
    input?.focus();
  }

  // 返信先を選んだら、すぐ入力できるように入力欄にフォーカスする
  $effect(() => {
    if (reply.get()) untrack(() => input?.focus());
  });

  export function focus() {
    input?.focus();
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
    if (attach.uploading) {
      ui.toast('添付をアップロードしています。終わってから送ってください');
      return;
    }
    if (!canSend) return;
    const body = parsed.body;
    if (!body) return;
    if (body.length > MAX_BODY) {
      ui.toast(`メッセージが長すぎます（${body.length} / ${MAX_BODY}文字）`, 'error');
      return;
    }
    client.sendMessage({ body, replyTo: reply.get(), silent });
    // 本文に残った添付は送られる。埋め込みを消した添付は消す
    attach.settle(body);
    reply.clear();
    input.clear();
    hasText = false;
    if (target) persistDraft(target, '');
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
        // 送らずに入力欄を空にした（下書きの破棄）。本文に無い添付は消す
        attach.dropUnsent('');
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

  {#if attach.items.length > 0 && !searching}
    <div class="composer-upload-tray">
      {#each attach.items as s (s.key)}
        <div class="composer-upload" class:composer-upload-failed={s.status === 'failed'} title={s.file.name}>
          {#if s.preview}
            {#if s.status === 'ready' && croppable(s)}
              <!-- 画像は、タップすると切り抜く範囲を選べる（送れたあとに切り抜くと、送るものが入れ替わる） -->
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
          {#if s.status === 'uploading'}
            <span class="composer-upload-state">{Math.round(s.progress * 100)}%</span>
          {:else if s.status === 'failed'}
            <span class="composer-upload-state composer-upload-error" role="alert">{s.error}</span>
            <button type="button" class="composer-upload-retry" onclick={() => attach.retry(s.key)}>再試行</button>
          {/if}
          <span class="composer-upload-name">{s.file.name}</span>
          <button type="button" class="composer-upload-remove" aria-label="取り消す" onclick={() => attach.cancel(s.key)}><X size={12} /></button>
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
      onclose={() => {
        attachPanel.hide();
        // 閉じたら、続けて書けるように入力欄へ戻す
        void tick().then(() => input?.focus());
      }}
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
            // 埋め込みを消された添付は、すぐ取り消す
            attach.sync(t);
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
        cropping = null;
        // 送れたあとの切り抜きは、切り抜いたものを上げ直して埋め込みを入れ替える
        attach.recrop(target.key, crop);
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
  .composer-upload-state {
    display: block;
    padding: var(--space-1) var(--space-3) 0;
    color: var(--text-muted);
    font-size: var(--fs-xs);
  }
  .composer-upload-error {
    color: var(--danger);
    overflow-wrap: anywhere;
  }
  .composer-upload-retry {
    display: block;
    padding: 0 var(--space-3);
    border: none;
    background: none;
    color: var(--accent);
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
