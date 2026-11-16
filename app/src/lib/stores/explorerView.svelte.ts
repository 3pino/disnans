import { explorer } from '../explorer/instance';

// 共有フォルダの一覧の表示方法と並び順（共有の部品の ExplorerView）。フォルダごと・この端末だけの設定
// （デバイスの設定 `explorerDirs`。保存先は explorer/instance.ts が渡す）。
export type { ViewMode, DirView } from '@3pino/explorer-kit';

export const explorerView = explorer.view;
