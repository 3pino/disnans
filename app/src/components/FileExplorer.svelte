<script lang="ts">
  import { untrack } from 'svelte';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import FileIcon from '@lucide/svelte/icons/file';
  import Folder from '@lucide/svelte/icons/folder';
  import ImageIcon from '@lucide/svelte/icons/image';
  import Upload from '@lucide/svelte/icons/upload';
  import FolderPlus from '@lucide/svelte/icons/folder-plus';
  import X from '@lucide/svelte/icons/x';
  import ClipboardPaste from '@lucide/svelte/icons/clipboard-paste';
  import ListChecks from '@lucide/svelte/icons/list-checks';
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
  import { explorerView } from '../lib/stores/explorerView.svelte';
  import Check from '@lucide/svelte/icons/check';
  import MenuIcon from '@lucide/svelte/icons/menu';
  import Menu from './ui/Menu.svelte';
  import MenuItem from './ui/MenuItem.svelte';
  import { attachmentActionText } from '../lib/fileLink';
  import { childPath, deleteManyConfirm, inAttachments, nameError, overwriteConfirm, planUpload } from '../lib/sharedOps';
  import { checkTransfer, runTransfer, transferFailure, type TransferItem } from '../lib/sharedTransfer';
  import { explorerBuffer } from '../lib/stores/explorerBuffer.svelte';
  import { explorerSelection } from '../lib/stores/explorerSelection.svelte';
  import { LONG_PRESS_MS } from '../lib/sortable';
  import { sharedApi, uploadShared } from '../lib/transport/shared';
  import { sharedFileUrl, fileUrl } from '../lib/config';
  import { isImage } from '../lib/fileLink';
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

  // 選択モードは、フォルダを変えたら外す（別のフォルダの項目を選んだままにしない）
  $effect(() => {
    void fileExplorer.dir;
    untrack(() => explorerSelection.clear());
  });

  function href(e: SharedEntry): string {
    return sharedFileUrl(e.path);
  }

  /** 並べ目（グリッド）の小さい画像。添付は縮小版（WebP）、共有フォルダの画像は原本。画像でなければ無し */
  function thumbUrl(e: SharedEntry): string | null {
    if (e.kind === 'dir' || !isImage(e.name, e.mime)) return null;
    return e.file_id ? fileUrl(e.file_id, true) : sharedFileUrl(e.path);
  }

  // 操作のメニュー（≡）。項目を選んだら閉じてから動く
  let menuOpen = $state(false);
  function run(fn: () => void): void {
    menuOpen = false;
    fn();
  }
  const VIEW_LABEL = { list: '一覧', details: '詳細', grid: 'アイコン' } as const;
  const KEY_LABEL = { name: '名前', modified: '更新日時', size: 'サイズ' } as const;

  function openImage(e: SharedEntry): void {
    const src = e.file_id ? fileUrl(e.file_id) : href(e);
    ui.lightbox = { src, alt: e.name, downloadUrl: src };
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

  // ---- 複数選択の操作（コピー・切り取り・削除・移動）。まとめて 1 回の確認（削除・上書き） ----

  /** 選んでいる項目（一覧に今ある分。消えたものは外す） */
  const selectedItems = $derived.by((): TransferItem[] => {
    if (listing?.kind !== 'ok') return [];
    const want = new Set(explorerSelection.paths());
    return [...listing.entries.values()].filter((e) => want.has(e.path)).map((e) => ({ path: e.path, kind: e.kind === 'dir' ? 'dir' : 'file' }));
  });

  /** 選んだ項目をコピー・切り取りする（できたことは、貼り付けが押せるようになることで分かるので通知は出さない） */
  function copySelected(): void {
    const items = selectedItems;
    // フォルダはコピーできない（除く。除いたことだけ知らせる）
    const allowed = items.filter((i) => checkTransfer('copy', i, fileExplorer.dir).ok);
    if (allowed.length < items.length) ui.toast(`フォルダはコピーできないので、${items.length - allowed.length} 件を除きました`);
    if (allowed.length === 0) return;
    explorerBuffer.set('copy', allowed);
    explorerSelection.clear();
  }

  function cutSelected(): void {
    const items = selectedItems;
    if (items.length === 0) return;
    explorerBuffer.set('move', items);
    explorerSelection.clear();
  }

  async function deleteSelected(): Promise<void> {
    const items = selectedItems;
    if (items.length === 0) return;
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
    if (ev.target instanceof Element && ev.target.closest('.shared-entry-actions')) return;
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

  /** 行を押したとき（選択モードの中では選び直す。長押しの直後は何もしない） */
  function rowClick(ev: MouseEvent, path: string, open: () => void): void {
    if (longPressed) {
      longPressed = false;
      ev.preventDefault();
      return;
    }
    if (explorerSelection.active) {
      ev.preventDefault();
      explorerSelection.toggle(path);
      return;
    }
    open();
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
    if (!explorerSelection.active) return;
    if (ev.target instanceof Element && ev.target.closest('.file-explorer-item, .file-explorer-menu, .menu-backdrop, .file-explorer-bar, .file-explorer-crumbs')) return;
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
        <IconButton label="切り取り" title={selectionReason('切り取り')} disabled={noneSelected} onclick={cutSelected}><Scissors size={18} /></IconButton>
        <IconButton label="削除" title={selectionReason('削除')} disabled={noneSelected} onclick={() => void deleteSelected()}><Trash size={18} /></IconButton>
      </div>
    </div>
    {#snippet actions()}
    <span class="file-explorer-popup">
      <IconButton label="メニュー" title="メニュー" active={menuOpen} onclick={() => (menuOpen = !menuOpen)}><MenuIcon size={18} /></IconButton>
      {#if menuOpen}
        <Menu class="file-explorer-popup-menu file-explorer-menu" label="共有フォルダの操作" onclose={() => (menuOpen = false)}>
          <MenuItem icon={Upload} onclick={() => run(() => fileInput?.click())}>アップロード</MenuItem>
          {#if canCreateFolder}
            <MenuItem icon={FolderPlus} onclick={() => run(openMkdir)}>新しいフォルダ</MenuItem>
          {/if}
          {#if !explorerBuffer.empty}
            <MenuItem icon={ClipboardPaste} onclick={() => run(() => void paste())}>貼り付け（{explorerBuffer.items.length} 件）</MenuItem>
          {/if}
          <MenuItem icon={ListChecks} onclick={() => run(() => explorerSelection.enter())}>選択モード</MenuItem>
          <p class="file-explorer-menu-head muted">表示</p>
          {#each ['list', 'details', 'grid'] as const as v (v)}
            <MenuItem onclick={() => run(() => explorerView.setView(v))}>{VIEW_LABEL[v]}{#if explorerView.view === v}<Check size={14} />{/if}</MenuItem>
          {/each}
          <p class="file-explorer-menu-head muted">並び替え</p>
          {#each ['name', 'modified', 'size'] as const as k (k)}
            <MenuItem onclick={() => run(() => explorerView.setSort(k, explorerView.sortOrder))}>{KEY_LABEL[k]}{#if explorerView.sortKey === k}<Check size={14} />{/if}</MenuItem>
          {/each}
          <MenuItem onclick={() => run(() => explorerView.setSort(explorerView.sortKey, 'asc'))}>昇順{#if explorerView.sortOrder === 'asc'}<Check size={14} />{/if}</MenuItem>
          <MenuItem onclick={() => run(() => explorerView.setSort(explorerView.sortKey, 'desc'))}>降順{#if explorerView.sortOrder === 'desc'}<Check size={14} />{/if}</MenuItem>
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

  <!-- 項目の外側（空きスペース）を押すと、選択を解除する（項目・バー・メニュー・パンくずは解除しない） -->
  <div class="scroll file-explorer-body" role="presentation" onclick={onbodyclick}>
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
      {@const sorted = sortEntries(listing.entries.values(), explorerView.sortKey, explorerView.sortOrder)}
      {#if explorerView.view === 'details'}
        <div class="file-explorer-columns" aria-hidden="true">
          <span class="file-explorer-col-name">名前</span>
          <span class="file-explorer-col-kind">種類</span>
          <span class="file-explorer-col-size">サイズ</span>
          <span class="file-explorer-col-date">更新日時</span>
        </div>
      {/if}
      <ul class="file-explorer-list file-explorer-view-{explorerView.view}">
        {#each sorted as e (e.path)}
          {@const action = entryAction(e)}
          {@const thumb = explorerView.view === 'grid' ? thumbUrl(e) : null}
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
            {#snippet row()}
              {#if explorerView.view === 'grid'}
                {#if explorerSelection.active}
                  <span class="file-explorer-check">{#if explorerSelection.has(e.path)}<SquareCheck size={18} />{:else}<Square size={18} />{/if}</span>
                {/if}
                <span class="file-explorer-thumb">
                  {#if thumb}
                    <img src={thumb} alt="" loading="lazy" decoding="async" />
                  {:else if action === 'enter'}<Folder size={32} />{:else if action === 'image'}<ImageIcon size={32} />{:else}<FileIcon size={32} />{/if}
                </span>
                <span class="file-explorer-name">{e.name}</span>
              {:else}
                <!-- 選択モードのときは、アイコンの場所にチェックを出す（同じ大きさで入れ替える） -->
                <span class="file-explorer-icon">
                  {#if explorerSelection.active}
                    <span class="file-explorer-check">{#if explorerSelection.has(e.path)}<SquareCheck size={18} />{:else}<Square size={18} />{/if}</span>
                  {:else if action === 'enter'}<Folder size={18} />{:else if action === 'image'}<ImageIcon size={18} />{:else}<FileIcon size={18} />{/if}
                </span>
                <span class="file-explorer-name">{e.name}</span>
                {#if explorerView.view === 'details'}
                  <span class="file-explorer-col-kind">{kindLabel(e)}</span>
                  <span class="file-explorer-col-size">{e.kind === 'file' ? formatSize(e.size) : ''}</span>
                  <span class="file-explorer-col-date">{formatStamp(e.modified, now)}</span>
                {:else}
                  <span class="file-explorer-meta">
                    {#if e.kind === 'file'}{formatSize(e.size)} · {/if}{formatStamp(e.modified, now)}
                  </span>
                {/if}
              {/if}
            {/snippet}
            {#if explorerSelection.active}
              <button type="button" class="file-explorer-row" aria-pressed={explorerSelection.has(e.path)} onclick={(ev) => rowClick(ev, e.path, () => {})}>{@render row()}</button>
            {:else if action === 'enter'}
              <button type="button" class="file-explorer-row" onclick={(ev) => rowClick(ev, e.path, () => fileExplorer.open(e.path))}>{@render row()}</button>
            {:else if action === 'image'}
              <button type="button" class="file-explorer-row" onclick={(ev) => rowClick(ev, e.path, () => openImage(e))}>{@render row()}</button>
            {:else}
              <a class="file-explorer-row" href={href(e)} download={e.name} target="_blank" rel="noopener" onclick={(ev) => rowClick(ev, e.path, () => {})}>{@render row()}</a>
            {/if}
            <!-- 添付のフォルダ（attachments/ そのもの）も出す（動かせない操作はグレーで理由つき） -->
            {#if !explorerSelection.active}
              <SharedEntryActions entry={e} placement={explorerView.view === 'grid' ? 'overlay' : 'inline'} />
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

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
  /* 選択の印（一覧は、アイコンと同じ場所に入れ替える。グリッドは画像の上に重ねる） */
  .file-explorer-check {
    flex: none;
    display: flex;
    color: var(--accent);
  }
  .file-explorer-item-selected .file-explorer-row {
    background: var(--hover);
  }
  .file-explorer-popup {
    position: relative;
    display: inline-flex;
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
  /* 詳細: 名前の列は残りの幅、ほかは決まった幅 */
  .file-explorer-columns,
  .file-explorer-view-details .file-explorer-item .file-explorer-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .file-explorer-columns {
    padding: var(--space-2) var(--space-5);
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
  .file-explorer-view-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: var(--space-3);
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
    gap: var(--space-2);
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
  .file-explorer-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .file-explorer-view-grid .file-explorer-name {
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
  /* アイコン（一覧・詳細）。選択モードの印と同じ箱（18px）に入れ、置き換えても位置がずれないようにする */
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
  .file-explorer-meta {
    flex: none;
    color: var(--text-muted);
    font-size: var(--fs-sm);
  }
  @media (hover: hover) {
    .file-explorer-row:hover {
      background: var(--hover);
    }
  }
</style>
