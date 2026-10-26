<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import FileIcon from '@lucide/svelte/icons/file';
  import Folder from '@lucide/svelte/icons/folder';
  import ImageIcon from '@lucide/svelte/icons/image';
  import Upload from '@lucide/svelte/icons/upload';
  import FolderPlus from '@lucide/svelte/icons/folder-plus';
  import X from '@lucide/svelte/icons/x';
  import ClipboardPaste from '@lucide/svelte/icons/clipboard-paste';
  import Square from '@lucide/svelte/icons/square';
  import SquareCheck from '@lucide/svelte/icons/square-check-big';
  import Copy from '@lucide/svelte/icons/copy';
  import Scissors from '@lucide/svelte/icons/scissors';
  import Trash from '@lucide/svelte/icons/trash';
  import IconButton from './ui/IconButton.svelte';
  import PanelBar from './ui/PanelBar.svelte';
  import Button from './ui/Button.svelte';
  import Modal from './ui/Modal.svelte';
  import TextInput from './ui/TextInput.svelte';
  import SharedEntryActions from './SharedEntryActions.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { fileExplorer } from '../lib/stores/fileExplorer.svelte';
  import { sharedIndex } from '../lib/stores/sharedIndex.svelte';
  import { breadcrumbs, entryAction, kindLabel, sortEntries } from '../lib/fileExplorer';
  import { explorerView, type ViewMode } from '../lib/stores/explorerView.svelte';
  import { baseName, parentOf } from '../lib/sharedPath';
  import Check from '@lucide/svelte/icons/check';
  import MenuIcon from '@lucide/svelte/icons/menu';
  import Menu from './ui/Menu.svelte';
  import MenuItem from './ui/MenuItem.svelte';
  import { attachmentActionText } from '../lib/fileLink';
  import { childPath, deleteManyConfirm, inAttachments, nameError, overwriteConfirm, planUpload, renameAllowed, renameTarget } from '../lib/sharedOps';
  import { checkTransfer, runTransfer, transferFailure, type TransferItem } from '../lib/sharedTransfer';
  import { explorerBuffer } from '../lib/stores/explorerBuffer.svelte';
  import { explorerSelection } from '../lib/stores/explorerSelection.svelte';
  import { LONG_PRESS_MS } from '../lib/sortable';
  import { copyText } from '../lib/clipboard';
  import { readClipboardImage, readNativeClipboardImage } from '../lib/clipboardImage';
  import { clipboardTextName, peekClipboard, readClipboardText, type ClipboardPeek } from '../lib/clipboardPaste';
  import { isLinuxDesktop } from '../lib/platform';
  import { sharedApi, uploadShared } from '../lib/transport/shared';
  import { sharedFileUrl, fileUrl } from '../lib/config';
  import { isImage, isPdf } from '../lib/fileLink';
  import { PDF_THUMB_MAX_BYTES } from '../lib/pdfThumb';
  import PdfThumb from './PdfThumb.svelte';
  import { formatSize, formatStamp } from '../lib/format';
  import type { SharedEntry } from '../lib/protocol/SharedEntry';

  // 共有フォルダの中身を見るパネル（閲覧だけ。書き込み・削除はしない）。見た目は仮（利用者の確認を取る）。
  // フォルダは中へ、画像は拡大表示、ほかのファイルはリンクで開く・保存する（明示的に押したときだけ）。
  // 一覧は sharedIndex の写し。files.changed で捨てられたら、ここで読み直す。
  const listing = $derived(fileExplorer.state);
  const crumbs = $derived(breadcrumbs(fileExplorer.dir));
  const now = Date.now();

  $effect(() => {
    const dir = fileExplorer.dir;
    if (sharedIndex.state(dir) === undefined) untrack(() => sharedIndex.ensure(dir));
  });

  // 選択モードと名前の書き換えは、フォルダを変えたら外す（別のフォルダの項目を選んだままにしない）
  $effect(() => {
    void fileExplorer.dir;
    untrack(() => {
      explorerSelection.clear();
      renamingPath = null;
    });
  });

  // 選択中の「戻る」（Android の戻る・Alt+←）は、選択モードを終える（フォルダやパネルは戻らない）
  $effect(() => {
    if (!explorerSelection.active) return;
    // 登録で読む ui.pluginBack には依存しない（依存すると、登録のたびにやり直して回り続ける）
    return untrack(() => ui.addPluginBack(() => explorerSelection.clear()));
  });

  /** 開いているフォルダの表示方法と並び順（フォルダごと・この端末） */
  const dirView = $derived(explorerView.of(fileExplorer.dir));
  function setView(v: ViewMode): void {
    explorerView.setView(fileExplorer.dir, v);
  }

  function href(e: SharedEntry): string {
    return sharedFileUrl(e.path);
  }

  /** 並べ目（グリッド）の小さい画像。添付は縮小版（WebP）、共有フォルダの画像は原本。画像でなければ無し */
  function thumbUrl(e: SharedEntry): string | null {
    if (e.kind === 'dir' || !isImage(e.name, e.mime)) return null;
    return e.file_id ? fileUrl(e.file_id, true) : sharedFileUrl(e.path);
  }

  /** PDF のサムネイルの元（1 ページ目を描く）。大きすぎる PDF・PDF でなければ無し */
  function pdfSource(e: SharedEntry): { url: string; key: string } | null {
    if (e.kind === 'dir' || !isPdf(e.name, e.mime) || e.size > PDF_THUMB_MAX_BYTES) return null;
    return { url: e.file_id ? fileUrl(e.file_id) : sharedFileUrl(e.path), key: `${e.path}:${e.modified}:${e.size}` };
  }

  // 操作のメニュー（≡）。項目を選んだら閉じてから動く
  let menuOpen = $state(false);
  function run(fn: () => void): void {
    menuOpen = false;
    fn();
  }
  const VIEW_LABEL = { details: '詳細', grid: 'アイコン' } as const;
  const KEY_LABEL = { name: '名前', modified: '更新日時', size: 'サイズ' } as const;

  /** 写真の拡大（前後は、このフォルダの画像を今の並び順で。ファイル・PDF は対象外） */
  function openImage(e: SharedEntry): void {
    const item = (x: SharedEntry) => {
      const src = x.file_id ? fileUrl(x.file_id) : href(x);
      return { src, alt: x.name, downloadUrl: src };
    };
    const folderImages = () =>
      listing?.kind === 'ok'
        ? sortEntries(listing.entries.values(), dirView.sortKey, dirView.sortOrder)
            .filter((x) => x.kind === 'file' && isImage(x.name, x.mime))
            .map(item)
        : [];
    ui.openLightbox(item(e), folderImages);
  }

  // ---- 書き込み（アップロード・新しいフォルダ）。どの人も変えられる。変わったことは files.changed で全員に届く ----

  /** 送信の 1 件（進み・失敗・中止）。送信中と失敗だけ並べ、成功したら消す */
  type Upload = { key: number; name: string; ratio: number; error: string | null; abort: (() => void) | null };
  let uploads = $state<Upload[]>([]);
  let uploadSeq = 0;
  let fileInput: HTMLInputElement | undefined = $state();

  /** attachments/ の中では新しいフォルダは作れない（中はファイルだけ） */
  const canCreateFolder = $derived(!inAttachments(fileExplorer.dir));

  function dropUpload(key: number): void {
    const u = uploads.find((x) => x.key === key);
    u?.abort?.();
    uploads = uploads.filter((x) => x.key !== key);
  }

  async function onPicked(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const picked = [...(input.files ?? [])];
    input.value = '';
    // 開いたフォルダに送る（途中でフォルダを移っても、最初のフォルダへ送る）
    const dir = fileExplorer.dir;
    for (const file of picked) await sendOne(dir, file);
  }

  /** 1 件を送る。同名があれば確認してから上書きする（確認なしには上書きしない） */
  async function sendOne(dir: string, file: File): Promise<void> {
    uploads.push({ key: ++uploadSeq, name: file.name, ratio: 0, error: null, abort: null });
    const row = uploads[uploads.length - 1];
    const plan = planUpload(dir, file.name, sharedIndex.state(dir) ?? { kind: 'loading' });
    if (plan.kind === 'blocked') {
      row.error = plan.message;
      return;
    }
    if (plan.kind === 'overwrite' && !(await ui.confirm(overwriteConfirm(plan.path)))) {
      dropUpload(row.key);
      return;
    }
    const h = uploadShared(plan.path, file, (r) => (row.ratio = r));
    row.abort = h.abort;
    try {
      await h.promise;
      dropUpload(row.key);
      sharedIndex.invalidate(plan.path);
    } catch (err) {
      // 中止（×で消した）は、失敗として出さない
      if (!uploads.some((x) => x.key === row.key)) return;
      row.abort = null;
      const aborted = err && typeof err === 'object' && (err as { code?: unknown }).code === 'aborted';
      if (aborted) dropUpload(row.key);
      else row.error = attachmentActionText(err);
    }
  }

  // ---- 貼り付け（アプリ内のバッファの項目を、開いているフォルダへ。切り取りは移動、コピーはコピー） ----

  let pasting = $state(false);

  async function paste(): Promise<void> {
    const mode = explorerBuffer.mode;
    if (pasting || !mode || explorerBuffer.empty) return;
    const dest = fileExplorer.dir;
    const st = sharedIndex.state(dest);
    if (st?.kind !== 'ok') {
      sharedIndex.ensure(dest);
      ui.toast('フォルダの中身を読み終えてから、もう一度貼り付けてください', 'error');
      return;
    }
    pasting = true;
    try {
      const result = await runTransfer({
        op: mode,
        items: [...explorerBuffer.items],
        destDir: dest,
        destEntries: st.entries,
        confirm: (c) => ui.confirm(c),
        api: sharedApi,
        invalidate: (p) => sharedIndex.invalidate(p),
      });
      // 切り取りは、移動したもの（と同じ場所で何もしなかったもの）をバッファから外す。
      // 上書きを取り消したもの・失敗したものは残す。コピーは残す
      if (mode === 'move') explorerBuffer.remove([...result.done, ...result.skipped].map((i) => i.path));
      const msg = transferFailure(result);
      if (msg) ui.toast(msg, 'error');
    } finally {
      pasting = false;
    }
  }

  // ---- OS のクリップボードとの同期 ----
  // コピー・切り取りは、項目のパスを OS のクリップボードにも書く。貼り付けは、クリップボードがまだその文字ならバッファを、
  // ほかでコピーし直していれば（ファイル・画像・文字）そちらを、開いているフォルダへ送る（文字は .txt のファイルにする）

  /** クリップボードに何があるか（貼り付けを押せるか）。開いたとき・前面に戻ったとき・コピーしたとき・メニューを開いたときに確かめ直す */
  let clip = $state<ClipboardPeek>({ text: false, image: false });
  async function refreshClip(): Promise<void> {
    clip = await peekClipboard();
  }
  const canPaste = $derived(!explorerBuffer.empty || clip === 'unknown' || clip.text || clip.image);

  onMount(() => {
    void refreshClip();
    const onFocus = () => void refreshClip();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshClip();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    document.addEventListener('paste', onPasteEvent);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
      document.removeEventListener('paste', onPasteEvent);
    };
  });

  /** バッファ（項目のパス）を OS のクリップボードにも書く。クリック・タップの処理の中から呼ぶ（でないと拒否される） */
  function syncToClipboard(): void {
    const text = explorerBuffer.items.map((i) => i.path).join('\n');
    void copyText(text).then((ok) => {
      // 書いている間にバッファを入れ替えていなければ、クリップボードと結び付ける
      if (ok && explorerBuffer.items.map((i) => i.path).join('\n') === text) explorerBuffer.clipText = text;
      void refreshClip();
    });
  }

  /** 貼り付け（バーのボタン・空きスペースのメニュー）。OS のクリップボードを読んで、何を貼るか決める */
  async function pasteAny(): Promise<void> {
    if (pasting) return;
    const dir = fileExplorer.dir;
    // バッファをクリップボードに書けていない（結び付いていない）なら、クリップボードは読まずにバッファを貼る
    if (!explorerBuffer.empty && explorerBuffer.clipText === null) return paste();
    await pasteWith(dir, await readClipboardText(), [], readClipboardImage);
  }

  /**
   * クリップボードの中身（files・text・画像）から貼る。ファイルがあればそれ。文字がバッファのもの（コピーしたまま）ならバッファ。
   * そうでなければ画像、文字（.txt）の順。どれも無ければバッファ
   */
  async function pasteWith(dir: string, text: string | null, files: File[], image: () => Promise<File | null>): Promise<void> {
    if (files.length > 0) {
      for (const f of files) await sendOne(dir, f);
      return;
    }
    if (!explorerBuffer.empty && (explorerBuffer.clipText === null || text === explorerBuffer.clipText)) return paste();
    const img = await image();
    if (img) return sendOne(dir, img);
    if (text) return sendOne(dir, new File([text], clipboardTextName(), { type: 'text/plain' }));
    if (!explorerBuffer.empty) return paste();
    ui.toast('クリップボードに貼り付けられるものがありません');
  }

  /** Ctrl+V（入力欄の外）。OS のファイル（エクスプローラーでコピーしたもの）もここで受け取れる */
  function onPasteEvent(ev: ClipboardEvent): void {
    const t = ev.target;
    if (t instanceof HTMLElement && (t.isContentEditable || t.closest('input, textarea, [contenteditable="true"]'))) return;
    ev.preventDefault();
    const files = [...(ev.clipboardData?.files ?? [])];
    const text = ev.clipboardData?.getData('text/plain') || null;
    // Linux の WebKitGTK は、画像のペーストで files が空になることがある
    void pasteWith(fileExplorer.dir, text, files, isLinuxDesktop() ? readNativeClipboardImage : async () => null);
  }

  // ---- 空きスペースの長押し（マウスは右クリック）のメニュー: アップロード・貼り付け ----

  let ctx = $state<{ x: number; y: number } | null>(null);
  let ctxTimer: ReturnType<typeof setTimeout> | undefined;
  let ctxFrom: { x: number; y: number } | null = null;
  /** 長押しでメニューを出した直後（指を離したときのタップで、出たメニューの幕を押して閉じないように） */
  let ctxByPress = false;

  /** 項目・ボタン・メニューの外（空きスペース）か */
  function isEmptySpot(t: EventTarget | null): boolean {
    return t instanceof Element && !t.closest('.file-explorer-item, .file-explorer-menu, .menu-backdrop, .file-explorer-columns, button, a, input, textarea');
  }

  function openCtx(x: number, y: number): void {
    ctx = { x, y };
    void refreshClip();
  }

  function runCtx(fn: () => void): void {
    ctx = null;
    fn();
  }

  function bodyPressStart(ev: PointerEvent): void {
    if (ev.pointerType === 'mouse' || !isEmptySpot(ev.target)) return;
    ctxByPress = false;
    ctxFrom = { x: ev.clientX, y: ev.clientY };
    clearTimeout(ctxTimer);
    ctxTimer = setTimeout(() => {
      const at = ctxFrom;
      ctxFrom = null;
      if (!at) return;
      ctxByPress = true;
      openCtx(at.x, at.y);
    }, LONG_PRESS_MS);
  }

  function bodyPressMove(ev: PointerEvent): void {
    if (!ctxFrom) return;
    if (Math.abs(ev.clientX - ctxFrom.x) > 8 || Math.abs(ev.clientY - ctxFrom.y) > 8) bodyPressEnd();
  }

  function bodyPressEnd(): void {
    clearTimeout(ctxTimer);
    ctxFrom = null;
  }

  /** 長押しでメニューを出したあと、指を離したときのタップ（クリック）を出さない */
  function bodyTouchEnd(ev: TouchEvent): void {
    if (!ctxByPress) return;
    ctxByPress = false;
    ev.preventDefault();
  }

  /** 右クリック（Android の長押しで出ることもある）。空きスペースならメニューを出す */
  function bodyContextMenu(ev: MouseEvent): void {
    if (!isEmptySpot(ev.target)) return;
    ev.preventDefault();
    if (!ctx) openCtx(ev.clientX, ev.clientY);
  }

  // ---- 複数選択の操作（コピー・切り取り・削除・移動）。まとめて 1 回の確認（削除・上書き） ----

  /** 選んでいる項目（一覧に今ある分。消えたものは外す） */
  const selectedItems = $derived.by((): TransferItem[] => {
    if (listing?.kind !== 'ok') return [];
    const want = new Set(explorerSelection.paths());
    return [...listing.entries.values()].filter((e) => want.has(e.path)).map((e) => ({ path: e.path, kind: e.kind === 'dir' ? 'dir' : 'file' }));
  });

  /** 選んだ項目に、切り取り・削除できないもの（添付のフォルダなど）があれば、その理由 */
  const cutBlocked = $derived(selectedItems.map((i) => checkTransfer('move', i, parentOf(i.path))).find((c) => !c.ok)?.message ?? null);
  const deleteBlocked = $derived(selectedItems.map((i) => renameAllowed(i.path)).find((c) => !c.ok)?.message ?? null);

  /** 選んだ項目をコピー・切り取りする（できたことは、貼り付けが押せるようになることで分かるので通知は出さない） */
  function copySelected(): void {
    const items = selectedItems;
    // フォルダはコピーできない（除く。除いたことだけ知らせる）
    const allowed = items.filter((i) => checkTransfer('copy', i, fileExplorer.dir).ok);
    if (allowed.length < items.length) ui.toast(`フォルダはコピーできないので、${items.length - allowed.length} 件を除きました`);
    if (allowed.length === 0) return;
    explorerBuffer.set('copy', allowed);
    syncToClipboard();
    explorerSelection.clear();
  }

  function cutSelected(): void {
    const items = selectedItems;
    if (items.length === 0 || cutBlocked) return;
    explorerBuffer.set('move', items);
    syncToClipboard();
    explorerSelection.clear();
  }

  async function deleteSelected(): Promise<void> {
    const items = selectedItems;
    if (items.length === 0 || deleteBlocked) return;
    if (!(await ui.confirm(deleteManyConfirm(items)))) return;
    const failed: string[] = [];
    for (const i of items) {
      try {
        await sharedApi.remove(i.path);
        sharedIndex.invalidate(i.path);
      } catch (err) {
        failed.push(`${i.path}: ${attachmentActionText(err)}`);
      }
    }
    explorerSelection.clear();
    if (failed.length > 0) ui.toast(`${failed.length} 件を削除できませんでした（${failed[0]}）`, 'error');
  }

  // ---- 行の操作: 長押しで選択モードに入る。選択モードの中では、行を押すと開かずに選び直す ----

  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let pressFrom: { x: number; y: number } | null = null;
  /** 長押しで選択に入ったところ（直後のクリックは無視する） */
  let longPressed = false;

  function pressStart(ev: PointerEvent, path: string): void {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    // 項目の「…」の上の長押しは、選択に入れない
    if (ev.target instanceof Element && ev.target.closest('.shared-entry-actions, .file-explorer-rename')) return;
    longPressed = false;
    pressFrom = { x: ev.clientX, y: ev.clientY };
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      longPressed = true;
      pressFrom = null;
      explorerSelection.start(path);
    }, LONG_PRESS_MS);
  }

  function pressMove(ev: PointerEvent): void {
    if (!pressFrom) return;
    if (Math.abs(ev.clientX - pressFrom.x) > 8 || Math.abs(ev.clientY - pressFrom.y) > 8) pressEnd();
  }

  function pressEnd(): void {
    clearTimeout(pressTimer);
    pressFrom = null;
  }

  /** 行を押したとき（選択モードの中では選び直す。長押しの直後は何もしない。名前の文字を押したら書き換える） */
  function rowClick(ev: MouseEvent, e: SharedEntry, open: () => void): void {
    if (longPressed) {
      longPressed = false;
      ev.preventDefault();
      return;
    }
    if (explorerSelection.active) {
      ev.preventDefault();
      explorerSelection.toggle(e.path);
      return;
    }
    if (ev.target instanceof Element && ev.target.closest('.file-explorer-name-text') && startRename(e)) {
      ev.preventDefault();
      return;
    }
    open();
  }

  /** 行のキー操作: F2 で名前を書き換える */
  function rowKey(ev: KeyboardEvent, e: SharedEntry): void {
    if (ev.key !== 'F2' || explorerSelection.active) return;
    if (startRename(e)) ev.preventDefault();
  }

  // ---- 名前の変更: 名前の文字を押すと、その場で入力欄に置き換わる。Enter・外を押すと確定、Esc で取り消し ----

  let renamingPath = $state<string | null>(null);
  let renameTo = $state('');
  let renameError = $state<string | null>(null);
  let renameBusy = $state(false);

  /** 書き換えを始める（名前を変えられない項目なら false。そのときは普通に開く） */
  function startRename(e: SharedEntry): boolean {
    if (!renameAllowed(e.path).ok) return false;
    renamingPath = e.path;
    renameTo = baseName(e.path);
    renameError = null;
    return true;
  }

  function cancelRename(): void {
    renamingPath = null;
  }

  async function commitRename(path: string): Promise<void> {
    if (renamingPath !== path || renameBusy) return;
    const to = renameTo.trim();
    if (to === baseName(path)) {
      renamingPath = null;
      return;
    }
    const bad = nameError(parentOf(path), to);
    if (bad) {
      renameError = bad;
      return;
    }
    renameBusy = true;
    try {
      await sharedApi.move(path, renameTarget(path, to));
      sharedIndex.invalidate(path);
      if (renamingPath === path) renamingPath = null;
    } catch (err) {
      renameError = attachmentActionText(err);
    } finally {
      renameBusy = false;
    }
  }

  function renameKey(ev: KeyboardEvent, path: string): void {
    if (ev.isComposing) return;
    if (ev.key === 'Enter') {
      ev.preventDefault();
      void commitRename(path);
    } else if (ev.key === 'Escape') {
      // パネルの Esc（閉じるなど）まで届かせない
      ev.preventDefault();
      ev.stopPropagation();
      cancelRename();
    }
  }

  /** 入力欄を出したら、拡張子の前までを選ぶ（すぐ打ち替えられるように） */
  function focusName(input: HTMLTextAreaElement): void {
    fitName(input);
    input.focus();
    const dot = input.value.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
  }

  /** 名前の入力欄の高さを中身に合わせる（長い名前は折り返して縦に伸ばす。改行は入れない: Enter は確定） */
  function fitName(input: HTMLTextAreaElement): void {
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
  }

  /** 選んでいる件数（0 のときは操作を押せない） */
  const noneSelected = $derived(explorerSelection.count === 0);
  /** 上端の件数: 選んでいるときは「N 件選択中」、選んでいないときはフォルダの項目数 */
  const countLabel = $derived.by(() => {
    if (explorerSelection.active) return `${explorerSelection.count} 件選択中`;
    return listing?.kind === 'ok' ? `${listing.entries.size} 件` : '';
  });
  /** 選択の操作が押せないときの理由（ホバーで出す） */
  function selectionReason(what: string): string {
    return noneSelected ? `項目を選ぶと${what}できます` : what;
  }

  /** 空きスペース（項目の外）を押したら、選択を解除する。項目・バー・メニュー・パンくずは解除しない */
  function onbodyclick(ev: MouseEvent): void {
    if (!explorerSelection.active || ctx) return;
    if (ev.target instanceof Element && ev.target.closest('.file-explorer-item, .file-explorer-menu, .menu-backdrop, .file-explorer-bar, .file-explorer-crumbs, .file-explorer-columns')) return;
    explorerSelection.clear();
  }

  let mkdirOpen = $state(false);
  let mkdirName = $state('');
  let mkdirError = $state<string | null>(null);
  let mkdirBusy = $state(false);

  function openMkdir(): void {
    mkdirName = '';
    mkdirError = null;
    mkdirOpen = true;
  }

  async function submitMkdir(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (mkdirBusy) return;
    const dir = fileExplorer.dir;
    const name = mkdirName.trim();
    const bad = nameError(dir, name);
    if (bad) {
      mkdirError = bad;
      return;
    }
    const path = childPath(dir, name);
    mkdirBusy = true;
    try {
      await sharedApi.mkdir(path);
      sharedIndex.invalidate(path);
      mkdirOpen = false;
    } catch (err) {
      mkdirError = attachmentActionText(err);
    } finally {
      mkdirBusy = false;
    }
  }
</script>

<div class="file-explorer">
  <!-- 上端は常に同じ（選択のバー + ≡）。選んでいないときは件数（フォルダ内の項目数）を出し、操作は選ぶまで押せない -->
  <PanelBar class="file-explorer-bar">
    <div class="file-explorer-selection" role="toolbar" aria-label="選んだ項目の操作">
      <span class="file-explorer-selection-count" aria-live="polite">{countLabel}</span>
      <div class="file-explorer-selection-actions">
        {#if listing?.kind === 'ok' && explorerSelection.active}
          <IconButton label="すべて選ぶ" title="すべて選ぶ" onclick={() => explorerSelection.selectAll([...listing.entries.values()].map((e) => e.path))}><SquareCheck size={18} /></IconButton>
        {/if}
        <IconButton label="コピー" title={selectionReason('コピー')} disabled={noneSelected} onclick={copySelected}><Copy size={18} /></IconButton>
        <IconButton label="切り取り" title={cutBlocked ?? selectionReason('切り取り')} disabled={noneSelected || cutBlocked !== null} onclick={cutSelected}><Scissors size={18} /></IconButton>
        <!-- 貼り付けは選ばなくても押せる（アプリ内でコピーしたもの、または OS のクリップボードの中身） -->
        <IconButton label="貼り付け" title={canPaste ? '貼り付け' : 'コピー・切り取りすると貼り付けられます'} disabled={!canPaste || pasting} onclick={() => void pasteAny()}><ClipboardPaste size={18} /></IconButton>
        <IconButton label="削除" title={deleteBlocked ?? selectionReason('削除')} disabled={noneSelected || deleteBlocked !== null} onclick={() => void deleteSelected()}><Trash size={18} /></IconButton>
      </div>
    </div>
    {#snippet actions()}
    <span class="file-explorer-popup">
      <IconButton label="メニュー" title="メニュー" active={menuOpen} onclick={() => (menuOpen = !menuOpen)}><MenuIcon size={18} /></IconButton>
      {#if menuOpen}
        <Menu class="file-explorer-popup-menu file-explorer-menu" label="共有フォルダの操作" onclose={() => (menuOpen = false)}>
          {#if canCreateFolder}
            <MenuItem icon={FolderPlus} onclick={() => run(openMkdir)}>新しいフォルダ</MenuItem>
          {/if}
          <!-- 表示・並び替えは、開いているフォルダの設定（この端末だけ。決めていない下のフォルダも従う） -->
          <p class="file-explorer-menu-head muted">表示</p>
          {#each ['details', 'grid'] as const as v (v)}
            <MenuItem onclick={() => run(() => setView(v))}>{VIEW_LABEL[v]}{#if dirView.view === v}<Check size={14} />{/if}</MenuItem>
          {/each}
          <p class="file-explorer-menu-head muted">並び替え</p>
          {#each ['name', 'modified', 'size'] as const as k (k)}
            <MenuItem onclick={() => run(() => explorerView.setSort(fileExplorer.dir, k, dirView.sortOrder))}>{KEY_LABEL[k]}{#if dirView.sortKey === k}<Check size={14} />{/if}</MenuItem>
          {/each}
          <MenuItem onclick={() => run(() => explorerView.setSort(fileExplorer.dir, dirView.sortKey, 'asc'))}>昇順{#if dirView.sortOrder === 'asc'}<Check size={14} />{/if}</MenuItem>
          <MenuItem onclick={() => run(() => explorerView.setSort(fileExplorer.dir, dirView.sortKey, 'desc'))}>降順{#if dirView.sortOrder === 'desc'}<Check size={14} />{/if}</MenuItem>
        </Menu>
      {/if}
    </span>
    <input bind:this={fileInput} type="file" multiple hidden onchange={onPicked} />
    {/snippet}
  </PanelBar>
  <!-- パンくず: 上端の下の行。場所を示すだけ（押すと、その場所へ） -->
  <nav class="file-explorer-crumbs" aria-label="場所">
    <button type="button" class="file-explorer-crumb" onclick={() => fileExplorer.open('')}>共有フォルダ</button>
    {#each crumbs as c (c.path)}
      <ChevronRight size={12} />
      <button type="button" class="file-explorer-crumb" onclick={() => fileExplorer.open(c.path)}>{c.name}</button>
    {/each}
  </nav>

  {#if uploads.length > 0}
    <ul class="file-explorer-uploads" aria-label="送信中のファイル">
      {#each uploads as u (u.key)}
        <li class="file-explorer-upload" class:file-explorer-upload-failed={u.error !== null}>
          <span class="file-explorer-upload-name">{u.name}</span>
          {#if u.error}
            <span class="file-explorer-upload-error" role="alert">{u.error}</span>
          {:else}
            <span class="file-explorer-upload-progress">{Math.round(u.ratio * 100)}%</span>
          {/if}
          <IconButton label="{u.name} を取り消す" onclick={() => dropUpload(u.key)}><X size={14} /></IconButton>
        </li>
      {/each}
    </ul>
  {/if}

  <!-- 項目の外側（空きスペース）を押すと、選択を解除する（項目・バー・メニュー・パンくずは解除しない）。長押し・右クリックでメニュー -->
  <!-- 詳細は、狭い画面では横にはみ出させてスワイプで見る（「…」は右端に固定して常に見せる） -->
  <div
    class="scroll file-explorer-body"
    class:file-explorer-body-details={dirView.view === 'details'}
    role="presentation"
    onclick={onbodyclick}
    onpointerdown={bodyPressStart}
    onpointermove={bodyPressMove}
    onpointerup={bodyPressEnd}
    onpointercancel={bodyPressEnd}
    ontouchend={bodyTouchEnd}
    oncontextmenu={bodyContextMenu}
  >
    {#if listing === undefined || listing.kind === 'loading'}
      <p class="file-explorer-status muted">読み込み中…</p>
    {:else if listing.kind === 'missing'}
      <p class="file-explorer-status muted">このフォルダは見つかりません。</p>
      <div class="file-explorer-retry"><Button onclick={() => fileExplorer.open('')}>{#snippet children()}共有フォルダへ戻る{/snippet}</Button></div>
    {:else if listing.kind === 'error'}
      <p class="file-explorer-status file-explorer-error" role="alert">読み込めませんでした: {listing.message}</p>
      <div class="file-explorer-retry"><Button onclick={() => fileExplorer.reload()}>{#snippet children()}再読み込み{/snippet}</Button></div>
    {:else if listing.entries.size === 0}
      <p class="file-explorer-status muted">このフォルダには、まだ何もありません。</p>
    {:else}
      {@const sorted = sortEntries(listing.entries.values(), dirView.sortKey, dirView.sortOrder)}
      {#if dirView.view === 'details'}
        <div class="file-explorer-columns" aria-hidden="true">
          <span class="file-explorer-col-name">名前</span>
          <span class="file-explorer-col-kind">種類</span>
          <span class="file-explorer-col-size">サイズ</span>
          <span class="file-explorer-col-date">更新日時</span>
          <span class="file-explorer-col-actions"></span>
        </div>
      {/if}
      <ul class="file-explorer-list file-explorer-view-{dirView.view}">
        {#each sorted as e (e.path)}
          {@const action = entryAction(e)}
          {@const thumb = dirView.view === 'grid' ? thumbUrl(e) : null}
          {@const pdf = dirView.view === 'grid' ? pdfSource(e) : null}
          {@const renaming = renamingPath === e.path}
          <li
            class="file-explorer-item"
            class:file-explorer-item-cut={explorerBuffer.isCut(e.path)}
            class:file-explorer-item-selected={explorerSelection.has(e.path)}
            onpointerdown={(ev) => pressStart(ev, e.path)}
            onpointermove={pressMove}
            onpointerup={pressEnd}
            onpointerleave={pressEnd}
            onpointercancel={pressEnd}
            oncontextmenu={(ev) => {
              if (explorerSelection.active || longPressed) ev.preventDefault();
            }}
          >
            {#snippet name()}
              {#if renaming}
                <span class="file-explorer-name file-explorer-name-editing">
                  <!-- 長い名前は折り返して縦に伸ばす（textarea。Enter は確定なので改行は入らない） -->
                  <textarea
                    class="file-explorer-rename"
                    aria-label="新しい名前"
                    aria-invalid={renameError !== null}
                    rows="1"
                    bind:value={renameTo}
                    disabled={renameBusy}
                    use:focusName
                    oninput={(ev) => fitName(ev.currentTarget)}
                    onkeydown={(ev) => renameKey(ev, e.path)}
                    onblur={() => void commitRename(e.path)}
                  ></textarea>
                  {#if renameError}
                    <span class="file-explorer-rename-error" role="alert">{renameError}</span>
                  {/if}
                </span>
              {:else}
                <!-- 名前の文字を押すと書き換える（文字の外の行は、押すと開く） -->
                <span class="file-explorer-name"><span class="file-explorer-name-text">{e.name}</span></span>
              {/if}
            {/snippet}
            {#snippet row()}
              {#if dirView.view === 'grid'}
                {#if explorerSelection.active}
                  <span class="file-explorer-check" class:file-explorer-check-on={explorerSelection.has(e.path)}>{#if explorerSelection.has(e.path)}<SquareCheck size={18} />{:else}<Square size={18} />{/if}</span>
                {/if}
                <span class="file-explorer-thumb">
                  {#if thumb}
                    <img src={thumb} alt="" loading="lazy" decoding="async" />
                  {:else if pdf}
                    <PdfThumb url={pdf.url} key={pdf.key} />
                  {:else if action === 'enter'}<Folder size={32} />{:else if action === 'image'}<ImageIcon size={32} />{:else}<FileIcon size={32} />{/if}
                </span>
                {@render name()}
              {:else}
                <!-- 詳細。選択モードのときは、アイコンの場所にチェックを出す（同じ大きさで入れ替える） -->
                <span class="file-explorer-icon">
                  {#if explorerSelection.active}
                    <span class="file-explorer-check" class:file-explorer-check-on={explorerSelection.has(e.path)}>{#if explorerSelection.has(e.path)}<SquareCheck size={18} />{:else}<Square size={18} />{/if}</span>
                  {:else if action === 'enter'}<Folder size={18} />{:else if action === 'image'}<ImageIcon size={18} />{:else}<FileIcon size={18} />{/if}
                </span>
                {@render name()}
                <span class="file-explorer-col-kind">{kindLabel(e)}</span>
                <span class="file-explorer-col-size">{e.kind === 'file' ? formatSize(e.size) : ''}</span>
                <span class="file-explorer-col-date">{formatStamp(e.modified, now)}</span>
              {/if}
            {/snippet}
            {#if renaming}
              <!-- 書き換え中は、入力欄を入れるため押せる行（button・a）にしない -->
              <div class="file-explorer-row">{@render row()}</div>
            {:else if explorerSelection.active}
              <button type="button" class="file-explorer-row" aria-pressed={explorerSelection.has(e.path)} onclick={(ev) => rowClick(ev, e, () => {})}>{@render row()}</button>
            {:else if action === 'enter'}
              <button type="button" class="file-explorer-row" onclick={(ev) => rowClick(ev, e, () => fileExplorer.open(e.path))} onkeydown={(ev) => rowKey(ev, e)}>{@render row()}</button>
            {:else if action === 'image'}
              <button type="button" class="file-explorer-row" onclick={(ev) => rowClick(ev, e, () => openImage(e))} onkeydown={(ev) => rowKey(ev, e)}>{@render row()}</button>
            {:else}
              <a class="file-explorer-row" href={href(e)} download={e.name} target="_blank" rel="noopener" onclick={(ev) => rowClick(ev, e, () => {})} onkeydown={(ev) => rowKey(ev, e)}>{@render row()}</a>
            {/if}
            <!-- 「…」（プロパティ）は、選択中も含めて常に見せる -->
            <SharedEntryActions entry={e} placement={dirView.view === 'grid' ? 'overlay' : 'inline'} />
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

<!-- 空きスペースの長押し・右クリックのメニュー（押したところに出す） -->
{#if ctx}
  <div class="file-explorer-context" style:left="{ctx.x}px" style:top="{ctx.y}px">
    <Menu class="file-explorer-context-menu file-explorer-menu" label="このフォルダの操作" onclose={() => (ctx = null)}>
      <MenuItem icon={Upload} onclick={() => runCtx(() => fileInput?.click())}>アップロード</MenuItem>
      {#if canPaste}
        <MenuItem icon={ClipboardPaste} disabled={pasting} onclick={() => runCtx(() => void pasteAny())}>貼り付け</MenuItem>
      {/if}
    </Menu>
  </div>
{/if}

{#if mkdirOpen}
  <Modal title="新しいフォルダ" onclose={() => (mkdirOpen = false)} width={380}>
    <form class="file-explorer-mkdir" onsubmit={submitMkdir}>
      <TextInput bind:value={mkdirName} aria-label="フォルダの名前" />
      {#if mkdirError}<p class="file-explorer-mkdir-error" role="alert">{mkdirError}</p>{/if}
      <div class="modal-actions">
        <Button onclick={() => (mkdirOpen = false)}>キャンセル</Button>
        <Button type="submit" variant="primary" disabled={mkdirBusy}>作成</Button>
      </div>
    </form>
  </Modal>
{/if}

<style>
  .file-explorer {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--bg);
  }
  /* パンくず: 上端の下の行。場所を示すだけ。小さく、背景を変えて区別する */
  .file-explorer-crumbs {
    flex: none;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-1) var(--space-4);
    overflow-x: auto;
    white-space: nowrap;
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
    color: var(--text-muted);
    font-size: var(--fs-xs);
  }
  .file-explorer-crumb {
    padding: var(--space-1) var(--space-2);
    border: none;
    border-radius: var(--radius-xs);
    background: none;
    color: inherit;
    font-size: inherit;
  }
  .file-explorer-crumbs > :last-child {
    color: var(--text);
    font-weight: var(--fw-semibold);
  }
  .file-explorer-body {
    flex: 1;
    min-height: 0;
    padding: var(--space-4);
  }
  /* 詳細: 狭い画面では、列を縮めずに横へはみ出させ、スワイプで見る（右の余白は無くし、右端に固定した「…」の外に列が覗かないようにする） */
  .file-explorer-body-details {
    overflow-x: auto;
    padding-right: 0;
  }
  .file-explorer-status {
    margin: var(--space-8) var(--space-7);
    text-align: center;
  }
  .file-explorer-error {
    color: var(--danger);
    overflow-wrap: anywhere;
  }
  .file-explorer-retry {
    display: flex;
    justify-content: center;
  }
  .file-explorer-list {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .file-explorer-uploads {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin: 0;
    padding: var(--space-3) var(--space-4);
    list-style: none;
    border-bottom: 1px solid var(--border);
    flex: none;
    font-size: var(--fs-sm);
  }
  .file-explorer-upload {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
  }
  .file-explorer-upload-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .file-explorer-upload-progress,
  .file-explorer-upload-error {
    flex: none;
    color: var(--text-muted);
  }
  .file-explorer-upload-failed .file-explorer-upload-error {
    color: var(--danger);
    overflow-wrap: anywhere;
  }
  .file-explorer-mkdir {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .file-explorer-mkdir-error {
    margin: 0;
    color: var(--danger);
    font-size: var(--fs-sm);
  }
  .file-explorer-item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }
  /* 切り取りの途中（貼り付けるまで残る）。消えたわけではないので薄くする */
  .file-explorer-item-cut {
    opacity: 0.5;
  }
  /* 上端のバーの左（件数と操作）。残りの幅を使い、狭いときは折り返す */
  .file-explorer-selection {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
  }
  .file-explorer-selection-count {
    font-size: var(--fs-sm);
    color: var(--text-muted);
    white-space: nowrap;
  }
  .file-explorer-selection-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1);
  }
  /* 選択の印（詳細は、アイコンと同じ場所に入れ替える。グリッドは画像の上に重ねる） */
  /* 選んでいない印は灰色、選んだ印は水色 */
  .file-explorer-check {
    flex: none;
    display: flex;
    color: var(--text-muted);
  }
  .file-explorer-check-on {
    color: var(--accent);
  }
  /* 選んだ項目は、行全体（「…」を含む）を明るい水色にする。「…」は詳細では右端に固定して下が透けないよう、色は不透明 */
  .file-explorer-item {
    --file-explorer-item-bg: var(--bg);
    border-radius: var(--radius-sm);
  }
  .file-explorer-item-selected {
    --file-explorer-item-bg: color-mix(in oklch, var(--accent) 18%, var(--bg));
    background: var(--file-explorer-item-bg);
  }
  .file-explorer-item-selected > :global(.shared-entry-actions .shared-entry-menu-button) {
    background: var(--file-explorer-item-bg);
  }
  .file-explorer-popup {
    position: relative;
    display: inline-flex;
  }
  /* 空きスペースのメニュー: 押したところを基準にする（大きさ 0 の箱。メニューは下か、入らなければ上に出す） */
  .file-explorer-context {
    position: fixed;
    width: 0;
    height: 0;
    z-index: var(--z-menu);
  }
  .file-explorer-context > :global(.file-explorer-context-menu) {
    position: absolute;
    top: 0;
    left: 0;
    min-width: 12em;
  }
  /* z-index は指定しない（design-system の .menu は --z-menu。ここで下げると外側の幕（-1）に覆われて項目が押せない） */
  .file-explorer-popup > :global(.file-explorer-popup-menu) {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    min-width: 12em;
  }
  .file-explorer-menu-head {
    margin: var(--space-3) 0 0;
    padding: 0 var(--space-4);
    font-size: var(--fs-xs);
  }
  /* 詳細: 名前の列は残りの幅、ほかは決まった幅。全体の幅は最低 540px（狭いときは横にはみ出す）。
     見出しと行は文字の大きさが違うので、全体と名前の幅は px でそろえる */
  .file-explorer-columns,
  .file-explorer-view-details .file-explorer-item .file-explorer-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .file-explorer-columns,
  .file-explorer-view-details {
    min-width: 540px;
  }
  /* 下に項目 2 つ分の空き（押すと選択を解除できる場所） */
  .file-explorer-view-details {
    padding-bottom: calc(2 * (2 * var(--space-4) + 1.5em));
  }
  .file-explorer-view-details .file-explorer-name,
  .file-explorer-columns .file-explorer-col-name {
    min-width: 120px;
  }
  /* 「…」は、横にスワイプしても右端に残す */
  .file-explorer-view-details .file-explorer-item > :global(.shared-entry-actions) {
    position: sticky;
    right: 0;
    background: var(--file-explorer-item-bg);
  }
  /* 見出しの「…」の列の空き（行の右の余白 + 隙間 + 「…」34px にそろえる） */
  .file-explorer-col-actions {
    flex: none;
    width: calc(var(--space-5) + var(--space-2) + 34px - var(--space-3));
  }
  .file-explorer-columns {
    padding: var(--space-2) 0 var(--space-2) var(--space-5);
    color: var(--text-muted);
    font-size: var(--fs-sm);
    border-bottom: 1px solid var(--border);
  }
  .file-explorer-col-name {
    flex: 1;
    min-width: 0;
  }
  .file-explorer-view-details .file-explorer-col-kind {
    flex: none;
    width: 4.5em;
    color: var(--text-muted);
    font-size: var(--fs-sm);
  }
  .file-explorer-view-details .file-explorer-col-size {
    flex: none;
    width: 5.5em;
    text-align: right;
    color: var(--text-muted);
    font-size: var(--fs-sm);
  }
  .file-explorer-view-details .file-explorer-col-date {
    flex: none;
    width: 8em;
    color: var(--text-muted);
    font-size: var(--fs-sm);
  }
  .file-explorer-columns .file-explorer-col-kind,
  .file-explorer-columns .file-explorer-col-size,
  .file-explorer-columns .file-explorer-col-date {
    flex: none;
  }
  .file-explorer-columns .file-explorer-col-kind {
    width: 4.5em;
  }
  .file-explorer-columns .file-explorer-col-size {
    width: 5.5em;
    text-align: right;
  }
  .file-explorer-columns .file-explorer-col-date {
    width: 8em;
  }
  /* アイコン（グリッド）: 並べ目。画像は正方形の縮小 */
  /* 項目の間と下に空き（押すと選択を解除できる場所）。下は項目 1 つ分（正方形の画像 + 名前）くらい。
     狭い画面は 2 列で項目が画面の半分ほどになるので、幅に合わせる（広い画面は 180px で止める） */
  .file-explorer-view-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: var(--space-6);
    padding-bottom: calc(min(50vw, 180px) + 2em);
  }
  .file-explorer-view-grid .file-explorer-item {
    position: relative;
    flex-direction: column;
    align-items: stretch;
    gap: 0;
  }
  .file-explorer-view-grid .file-explorer-row {
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-4);
    padding: var(--space-2);
  }
  .file-explorer-thumb {
    display: flex;
    align-items: center;
    justify-content: center;
    aspect-ratio: 1;
    border-radius: var(--radius-xs);
    background: var(--surface-2);
    color: var(--text-muted);
    overflow: hidden;
  }
  /* 画像は欠けないよう、全体を枠に収める（余りは枠の地の色） */
  .file-explorer-thumb img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .file-explorer-view-grid .file-explorer-name {
    flex: none;
    text-align: center;
    font-size: var(--fs-sm);
  }
  .file-explorer-view-grid .file-explorer-check {
    position: absolute;
    top: var(--space-2);
    left: var(--space-2);
    z-index: 1;
    background: var(--surface);
    border-radius: var(--radius-xs);
  }

  .file-explorer-row {
    display: flex;
    align-items: center;
    gap: var(--space-5);
    flex: 1;
    min-width: 0;
    padding: var(--space-4) var(--space-5);
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: inherit;
    text-align: left;
    text-decoration: none;
    font-size: var(--fs-base);
  }
  /* アイコン（詳細）。選択モードの印と同じ箱（18px）に入れ、置き換えても位置がずれないようにする */
  .file-explorer-icon {
    flex: none;
    display: flex;
    justify-content: center;
    width: 18px;
    color: var(--text-muted);
  }
  .file-explorer-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* 名前の文字（押すと書き換える） */
  .file-explorer-name-text {
    cursor: text;
  }
  .file-explorer-name-editing {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    overflow: visible;
    white-space: normal;
  }
  .file-explorer-rename {
    width: 100%;
    min-width: 0;
    padding: var(--space-1) var(--space-3);
    border: 1px solid var(--accent);
    border-radius: var(--radius-xs);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    line-height: 1.4;
    resize: none;
    overflow: hidden;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  /* 枠（青）でフォーカスが分かるので、フォーカスの輪（白）は出さない */
  .file-explorer-rename:focus,
  .file-explorer-rename:focus-visible {
    outline: none;
  }
  .file-explorer-rename[aria-invalid='true'] {
    border-color: var(--danger);
  }
  .file-explorer-rename-error {
    font-size: var(--fs-xs);
    overflow-wrap: anywhere;
  }
  .file-explorer-rename-error {
    color: var(--danger);
  }
  @media (hover: hover) {
    .file-explorer-row:hover {
      background: var(--hover);
    }
  }
</style>
