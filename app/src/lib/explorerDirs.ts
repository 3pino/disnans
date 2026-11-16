// 共有フォルダの一覧の表示方法と並び順（フォルダごと）の、純粋な部品。本体は共有の部品（@3pino/explorer-kit の dirs）。
// 保存先は、デバイスの設定の項目 `explorerDirs`（この端末だけ。stores/deviceSettings が読み書きする）。
// ここに残すのは、以前の localStorage の保存の引き継ぎ（Disnans だけのもの）。

import { DEFAULT_DIR_VIEW, parseDirViewMap, parseView, type DirViewMap } from '@3pino/explorer-kit';
import type { SortKey, SortOrder } from './fileExplorer';

export {
  EXPLORER_DIRS_MAX,
  EXPLORER_DIRS_MAX_BYTES,
  DEFAULT_DIR_VIEW,
  parseView,
  parseDirViewMap,
  withDirView,
  inheritedDirView,
} from '@3pino/explorer-kit';
export type { ViewMode, DirView, DirViewMap } from '@3pino/explorer-kit';

const KEYS: readonly string[] = ['name', 'modified', 'size'];
const ORDERS: readonly string[] = ['asc', 'desc'];

/** 以前の localStorage の保存先（読むだけ）。旧い一覧（disnans.explorer.dirs）が読めればそれ。無ければ端末全体の旧い設定を、直下（ルート）の設定として引き継ぐ */
export const LEGACY_EXPLORER_KEYS = { dirs: 'disnans.explorer.dirs', view: 'disnans.explorer.view', sort: 'disnans.explorer.sort' } as const;

export function legacyExplorerDirs(read: (key: string) => string | null): DirViewMap | null {
  const dirsRaw = read(LEGACY_EXPLORER_KEYS.dirs);
  if (dirsRaw !== null) {
    try {
      const parsed: unknown = JSON.parse(dirsRaw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parseDirViewMap(parsed);
    } catch {
      // 壊れた保存は捨てて、下の旧い設定を見る
    }
  }
  const view = parseView(read(LEGACY_EXPLORER_KEYS.view));
  const sort = (read(LEGACY_EXPLORER_KEYS.sort) ?? '').split(':');
  const sortOk = sort.length === 2 && KEYS.includes(sort[0]) && ORDERS.includes(sort[1]);
  if (!view && !sortOk) return null;
  return {
    '': {
      view: view ?? DEFAULT_DIR_VIEW.view,
      sortKey: sortOk ? (sort[0] as SortKey) : DEFAULT_DIR_VIEW.sortKey,
      sortOrder: sortOk ? (sort[1] as SortOrder) : DEFAULT_DIR_VIEW.sortOrder,
    },
  };
}
