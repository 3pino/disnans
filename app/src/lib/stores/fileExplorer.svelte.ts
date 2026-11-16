import { explorer } from '../explorer/instance';

/**
 * 共有フォルダを見る画面の、いま開いているフォルダ（共有の部品の ExplorerNav）。中身は sharedIndex（files.changed で読み直される）から引く。
 * 接続先が変わったら、いちばん上へ戻る（explorer/instance.ts の scope）。
 */
export const fileExplorer = explorer.nav;
