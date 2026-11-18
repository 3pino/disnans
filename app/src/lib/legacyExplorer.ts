// 【移行・削除してよい】以前の内蔵のエクスプローラーの保存（localStorage の旧い表示・並び順）を、一度だけ読み替える。
// 使う先は2つ: (1) デバイスの設定 explorerDirs の取り込み（lib/settingsModel.ts）、(2) 「ファイル」のプラグインへの取り込み（legacyData。lib/plugins/host.svelte.ts）。
// 内蔵の画面は API 20 で外した。次の版で旧い利用者がいないと判断したら、このファイルと上の2か所の呼び出しを消す。
// 中身は、以前の共有の部品（@3pino/explorer-kit の dirs）と同じ決まり（値の形・上限・読み方）。

export type ViewMode = 'details' | 'grid';
export type SortKey = 'name' | 'modified' | 'size';
export type SortOrder = 'asc' | 'desc';
export type DirView = { view: ViewMode; sortKey: SortKey; sortOrder: SortOrder };
export type DirViewMap = Record<string, DirView>;

/** 覚えておくフォルダの数の上限 */
export const EXPLORER_DIRS_MAX = 200;
/** 保存の大きさの上限（UTF-8 のバイト数） */
export const EXPLORER_DIRS_MAX_BYTES = 24 * 1024;

export const DEFAULT_DIR_VIEW: DirView = { view: 'details', sortKey: 'name', sortOrder: 'asc' };
const VIEWS: readonly string[] = ['details', 'grid'];
const KEYS: readonly string[] = ['name', 'modified', 'size'];
const ORDERS: readonly string[] = ['asc', 'desc'];

/** 以前の localStorage の保存先（読むだけ） */
export const LEGACY_EXPLORER_KEYS = { dirs: 'disnans.explorer.dirs', view: 'disnans.explorer.view', sort: 'disnans.explorer.sort' } as const;

/** 旧い「一覧」（list）は詳細として読む */
export function parseView(v: unknown): ViewMode | null {
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

/** 保存された値を読む。知らない項目は捨て、残りは順番のまま。上限を超えたら古いもの（先頭）から捨てる */
export function parseDirViewMap(raw: unknown): DirViewMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const entries: [string, DirView][] = [];
  for (const [dir, v] of Object.entries(raw as Record<string, unknown>)) {
    const dv = parseDirView(v);
    if (dv) entries.push([dir, dv]);
  }
  return fitDirViewMap(entries);
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** 件数と大きさの上限に収める（先頭＝古いものから捨てる）。1 件だけでも大きさを超えるなら、その件は覚えない */
function fitDirViewMap(entries: [string, DirView][]): DirViewMap {
  let kept = entries.length > EXPLORER_DIRS_MAX ? entries.slice(entries.length - EXPLORER_DIRS_MAX) : entries;
  let out = Object.fromEntries(kept);
  while (kept.length > 0 && byteLength(JSON.stringify(out)) > EXPLORER_DIRS_MAX_BYTES) {
    kept = kept.slice(1);
    out = Object.fromEntries(kept);
  }
  return out;
}

/** 以前の localStorage の保存先（読むだけ）。旧い一覧（disnans.explorer.dirs）が読めればそれ。無ければ端末全体の旧い設定を、直下（ルート）の設定として引き継ぐ */
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
