import { getItem, setItem } from '../storage';
import { parentOf } from '../sharedPath';
import type { SortKey, SortOrder } from '../fileExplorer';

// 共有フォルダの一覧の表示方法と並び順。フォルダごと・この端末だけの設定（local-only。ブラウザの保存領域に入れる。サーバーには送らない）。
// 決めていないフォルダは、いちばん近い上のフォルダの設定に従う（どこにも無ければ既定: 詳細・名前の昇順）。
// 読めない・知らない値は捨てる（旧版の「一覧」は詳細として読む）

export type ViewMode = 'details' | 'grid';
export type DirView = { view: ViewMode; sortKey: SortKey; sortOrder: SortOrder };

const DIRS_KEY = 'disnans.explorer.dirs';
/** 旧版（端末全体で 1 つ）の保存。あれば、共有フォルダ直下の設定として引き継ぐ */
const OLD_VIEW_KEY = 'disnans.explorer.view';
const OLD_SORT_KEY = 'disnans.explorer.sort';
/** 覚えておくフォルダの数（古く変えたものから捨てる） */
const MAX_DIRS = 300;
const VIEWS: readonly string[] = ['details', 'grid'];
const KEYS: readonly string[] = ['name', 'modified', 'size'];
const ORDERS: readonly string[] = ['asc', 'desc'];
const DEFAULT: DirView = { view: 'details', sortKey: 'name', sortOrder: 'asc' };

function parseView(v: unknown): ViewMode | null {
  if (v === 'list') return 'details';
  return typeof v === 'string' && VIEWS.includes(v) ? (v as ViewMode) : null;
}

function parseDirView(v: unknown): DirView | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const view = parseView(o.view);
  if (!view || typeof o.sortKey !== 'string' || !KEYS.includes(o.sortKey) || typeof o.sortOrder !== 'string' || !ORDERS.includes(o.sortOrder)) return null;
  return { view, sortKey: o.sortKey as SortKey, sortOrder: o.sortOrder as SortOrder };
}

function load(): Record<string, DirView> {
  const out: Record<string, DirView> = {};
  try {
    const raw: unknown = JSON.parse(getItem(DIRS_KEY) ?? 'null');
    if (raw && typeof raw === 'object') {
      for (const [dir, v] of Object.entries(raw)) {
        const dv = parseDirView(v);
        if (dv) out[dir] = dv;
      }
      return out;
    }
  } catch {
    // 壊れた保存は捨てる
  }
  // 旧版の保存を、直下の設定として引き継ぐ
  const view = parseView(getItem(OLD_VIEW_KEY));
  const sort = (getItem(OLD_SORT_KEY) ?? '').split(':');
  const sortOk = sort.length === 2 && KEYS.includes(sort[0]) && ORDERS.includes(sort[1]);
  if (view || sortOk) {
    out[''] = {
      view: view ?? DEFAULT.view,
      sortKey: sortOk ? (sort[0] as SortKey) : DEFAULT.sortKey,
      sortOrder: sortOk ? (sort[1] as SortOrder) : DEFAULT.sortOrder,
    };
  }
  return out;
}

class ExplorerView {
  private dirs = $state<Record<string, DirView>>(load());

  /** このフォルダの表示（決めていなければ上のフォルダ、無ければ既定） */
  of(dir: string): DirView {
    for (let d = dir; ; d = parentOf(d)) {
      const v = this.dirs[d];
      if (v) return v;
      if (d === '') return DEFAULT;
    }
  }

  setView(dir: string, view: ViewMode): void {
    this.put(dir, { ...this.of(dir), view });
  }

  setSort(dir: string, sortKey: SortKey, sortOrder: SortOrder): void {
    this.put(dir, { ...this.of(dir), sortKey, sortOrder });
  }

  /** 保存を消す（テスト用） */
  reset(): void {
    this.dirs = {};
    setItem(DIRS_KEY, null);
  }

  private put(dir: string, v: DirView): void {
    // 変えたものを最後に置き、多すぎたら古いものから捨てる
    const next = Object.fromEntries(Object.entries(this.dirs).filter(([d]) => d !== dir));
    next[dir] = v;
    const entries = Object.entries(next);
    this.dirs = Object.fromEntries(entries.slice(Math.max(0, entries.length - MAX_DIRS)));
    setItem(DIRS_KEY, JSON.stringify(this.dirs));
  }
}

export const explorerView = new ExplorerView();
