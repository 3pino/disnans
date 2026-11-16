// Disnans の共有フォルダのエクスプローラー（アプリに 1 つ）。画面と決まりは共有の部品（@3pino/explorer-kit）。
// ここは、その 2 つの口へ Disnans の実装を渡す:
//  - 置き場所: サーバーの共有フォルダ（sharedApi・項目の URL・共有フォルダの決まり・接続先）
//  - 本体から借りる機能: 通知・確認・戻る・拡大表示・クリップボード・保存・OS からのドロップ・この端末の種類
// どの口も、呼ばれたときに本体の関数を呼ぶ（読み込みの順番に依らない。試験での差し替えも効く）。
import Search from '@lucide/svelte/icons/search';
import { createExplorer, type EntryUrls, type ExplorerApi, type ExplorerHost } from '@3pino/explorer-kit';
import PdfThumb from '../../components/PdfThumb.svelte';
import { getServerUrl, onServerChange } from '../config';
import { copyText } from '../clipboard';
import { readClipboardImage, readNativeClipboardImage } from '../clipboardImage';
import { clipboardTextName, peekClipboard, readClipboardText } from '../clipboardPaste';
import { diagLog } from '../diagLog';
import { downloadFile, interceptDownload } from '../download';
import { dropRootsOf, entriesFromDropRoots, listenNativeDrop, listenOsDrop, osDropEntries, osDropRelease } from '../dropFiles';
import { attachmentActionText, isImage } from '../fileLink';
import type { LightboxItem } from '../lightbox';
import { isLinuxDesktop, isTauri, osName } from '../platform';
import { SHARED_RULES } from '../sharedOps';
import { deviceSettings } from '../stores/deviceSettings.svelte';
import { messageSearch } from '../stores/search.svelte';
import { sharedIndex } from '../stores/sharedIndex.svelte';
import { ui } from '../stores/ui.svelte';
import { sharedApi, uploadShared } from '../transport/shared';
import { viewerKind } from '../viewers';
import { href, pdfSource, readUrl, thumbUrl } from './urls';

// 引数は、渡されたとおりに送る（省いた引数を undefined で足さない）
const api: ExplorerApi = {
  list: (...a) => sharedApi.list(...a),
  write: (...a) => sharedApi.write(...a),
  mkdir: (...a) => sharedApi.mkdir(...a),
  trash: (...a) => sharedApi.trash(...a),
  restore: (...a) => sharedApi.restore(...a),
  purge: (...a) => sharedApi.purge(...a),
  size: (...a) => sharedApi.size(...a),
  move: (...a) => sharedApi.move(...a),
  copy: (...a) => sharedApi.copy(...a),
  upload: (...a) => uploadShared(...a),
};

const urls: EntryUrls = {
  href: (e) => href(e),
  readUrl: (e, thumb) => readUrl(e, thumb),
  thumbUrl: (e) => thumbUrl(e),
  pdfSource: (e) => pdfSource(e),
};

const host: ExplorerHost = {
  toast: (...args) => ui.toast(...args),
  confirm: (opts) => ui.confirm(opts),
  addBack: (run) => ui.addPluginBack(run),
  openViewer: (item, gallery) => ui.openLightbox(item as LightboxItem, gallery as () => LightboxItem[]),
  viewerKind: (name, mime) => viewerKind(name, mime),
  isImage: (name, mime) => isImage(name, mime),
  errorText: (e) => attachmentActionText(e),
  log: (level, text) => diagLog(level, text),
  platform: {
    isTauri: () => isTauri(),
    osName: () => osName(),
    isLinuxDesktop: () => isLinuxDesktop(),
  },
  clipboard: {
    copyText: (text) => copyText(text),
    peek: () => peekClipboard(),
    readText: () => readClipboardText(),
    readImage: () => readClipboardImage(),
    readNativeImage: () => readNativeClipboardImage(),
    textName: () => clipboardTextName(),
  },
  download: {
    file: (req) => downloadFile(req),
    intercept: (ev, req) => interceptDownload(ev, req),
  },
  osDrop: {
    listenNative: (handler) => listenNativeDrop(handler),
    listen: (handler) => listenOsDrop(handler),
    entries: (id) => osDropEntries(id),
    release: (id) => osDropRelease(id),
    rootsOf: (dt) => dropRootsOf(dt),
    entriesFromRoots: (roots) => entriesFromDropRoots(roots),
  },
  PdfThumb,
  // ファイルのプロパティの「メッセージを検索」: このファイルの名前でメッセージを探す（リンクしたファイルは、今の名前で検索に当たる）
  fileAction: {
    label: 'メッセージを検索',
    icon: Search,
    run: (_entry, label) => {
      ui.openSearch();
      messageSearch.setQuery(label);
    },
  },
};

export const explorer = createExplorer({
  api,
  urls,
  rules: SHARED_RULES,
  labels: { root: '共有フォルダ', upload: 'アップロード' },
  host,
  // 一覧の写しは、本文のファイルリンクと共有する（接続先が変わったときに捨てるのは sharedIndex 自身）
  index: sharedIndex,
  // 接続先が変わったら、旧サーバーの場所を開いたままにしない
  scope: { key: () => getServerUrl(), onChange: (cb) => onServerChange(cb) },
  // フォルダごとの表示は、この端末の設定（explorerDirs）
  viewStore: {
    read: () => deviceSettings.raw.explorerDirs,
    write: (map) => deviceSettings.set('explorerDirs', map),
  },
});
