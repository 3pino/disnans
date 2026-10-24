import { getItem, setItem } from '../storage';
import type { SortKey, SortOrder } from '../fileExplorer';

// 共有フォルダの一覧の表示方法と並び順。この端末だけの設定（local-only。ブラウザの保存領域に入れる。サーバーには送らない）
// 読めない・知らない値のときは既定（一覧・名前の昇順）

export type ViewMode = 'list' | 'details' | 'grid';

const VIEW_KEY = 'disnans.explorer.view';
const SORT_KEY = 'disnans.explorer.sort';
const VIEWS: readonly ViewMode[] = ['list', 'details', 'grid'];
const KEYS: readonly SortKey[] = ['name', 'modified', 'size'];
const ORDERS: readonly SortOrder[] = ['asc', 'desc'];

class ExplorerView {
  view = $state<ViewMode>('list');
  sortKey = $state<SortKey>('name');
  sortOrder = $state<SortOrder>('asc');

  constructor() {
    const v = getItem(VIEW_KEY);
    if (v && (VIEWS as readonly string[]).includes(v)) this.view = v as ViewMode;
    const sort = (getItem(SORT_KEY) ?? '').split(':');
    if (sort.length === 2 && (KEYS as readonly string[]).includes(sort[0]) && (ORDERS as readonly string[]).includes(sort[1])) {
      this.sortKey = sort[0] as SortKey;
      this.sortOrder = sort[1] as SortOrder;
    }
  }

  setView(v: ViewMode): void {
    this.view = v;
    setItem(VIEW_KEY, v);
  }

  setSort(key: SortKey, order: SortOrder): void {
    this.sortKey = key;
    this.sortOrder = order;
    setItem(SORT_KEY, `${key}:${order}`);
  }
}

export const explorerView = new ExplorerView();
