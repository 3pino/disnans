import { moveItem } from './sortable';

// ナビゲーションバーに出すコマンドの並び（端末ごと。lib/stores/navBar.svelte.ts に保存する）
// 項目は本体・プラグインのコマンドの ID（app:open-chat など）。登録されていないもの（外したプラグインなど）は出さないが、並びには残す

export const NAV_CHAT_ID = 'app:open-chat';
export const NAV_THREADS_ID = 'app:open-threads';
export const NAV_SETTINGS_ID = 'app:open-settings';
/** 通話の画面。既定の並びには入れない（利用者が追加する）。コマンドとして登録される（lib/call/commands.ts） */
export const NAV_CALL_ID = 'app:call-open';
/** 検索（コマンドとして登録される。既定の表示名は Search） */
export const NAV_SEARCH_ID = 'app:search';

/** 本体の3つ（チャット・スレッド・設定）。コマンドの登録より前に出るので、登録されていなくても出す */
export const NAV_BUILTIN_IDS: readonly string[] = [NAV_CHAT_ID, NAV_THREADS_ID, NAV_SETTINGS_ID];

/** 外せない項目。チャットと設定は、設定画面に戻れるように必ず出す */
export const NAV_REQUIRED_IDS: readonly string[] = [NAV_CHAT_ID, NAV_SETTINGS_ID];

/** 既定の並び（デスクトップではスレッドはサイドバーに出るので、表示では外れる） */
export const DEFAULT_NAV_ITEMS: readonly string[] = [NAV_CHAT_ID, NAV_THREADS_ID, NAV_SETTINGS_ID];

/**
 * 保存したもの（端末の localStorage）を読む。配列でなければ既定。文字列でないものと重複は捨てる。
 * 必須の項目がなければ末尾に足す
 */
export function normalizeNavItems(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...DEFAULT_NAV_ITEMS];
  const out = [...new Set(raw.filter((x): x is string => typeof x === 'string' && x !== ''))];
  for (const id of NAV_REQUIRED_IDS) if (!out.includes(id)) out.push(id);
  return out;
}

/**
 * 出す項目を、並びの順に返す。本体の3つは常に出し、ほかは登録されている（available に入っている）ものだけ。
 * デスクトップ（withThreads が false）ではスレッドの項目を出さない
 */
export function visibleNavItems(list: readonly string[], available: ReadonlySet<string>, { withThreads }: { withThreads: boolean }): string[] {
  return list.filter((id) => (available.has(id) || NAV_BUILTIN_IDS.includes(id)) && (withThreads || id !== NAV_THREADS_ID));
}

/** 項目を末尾に足す。もう入っていれば変えない */
export function addNavItem(list: readonly string[], id: string): string[] {
  return list.includes(id) ? [...list] : [...list, id];
}

/** 項目を外す。必須の項目は外せない（変えない） */
export function removeNavItem(list: readonly string[], id: string): string[] {
  if (NAV_REQUIRED_IDS.includes(id)) return [...list];
  return list.filter((x) => x !== id);
}

/**
 * 項目を、表示の並び（available にあるものの並び）の toIndex 番目に動かす（並べ替えのリストで使う）。
 * 登録されていない項目は位置を変えずに残す
 */
export function reorderNavItem(list: readonly string[], available: ReadonlySet<string>, id: string, toIndex: number): string[] {
  const shown = list.filter((x) => available.has(x));
  const from = shown.indexOf(id);
  if (from < 0) return [...list];
  const next = moveItem(shown, from, toIndex);
  let k = 0;
  return list.map((x) => (available.has(x) ? next[k++] : x));
}

/**
 * 既定の表示名（短い英語）。ここにないものは、表示名を設定しなければコマンド名を出す
 */
export const DEFAULT_NAV_LABELS: Readonly<Record<string, string>> = {
  [NAV_CHAT_ID]: 'Chat',
  [NAV_THREADS_ID]: 'Threads',
  [NAV_SETTINGS_ID]: 'Settings',
  [NAV_CALL_ID]: 'Call',
  [NAV_SEARCH_ID]: 'Search',
};

/**
 * 保存した表示名（端末の localStorage）を読む。オブジェクトでなければ空。文字列でない値は捨てる。
 * 空欄（""）は「設定済みで空欄」の意味なので残す（未設定＝キーがないこととは区別する）
 */
export function normalizeNavLabels(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw)) {
    if (typeof v === 'string') out[id] = v.trim();
  }
  return out;
}

/**
 * 項目の表示名を決める。
 * 未設定（キーがない）→ 既定の短い名前（なければコマンド名）、設定済みで空欄 → コマンド名、設定済み → その名前。
 * コマンド名がわからないとき（未登録）は ID を出す
 */
export function navItemLabel(id: string, commandName: string | undefined, labels: Readonly<Record<string, string>>): string {
  const fallback = commandName ?? id;
  if (Object.hasOwn(labels, id)) {
    const set = labels[id];
    return set === '' ? fallback : set;
  }
  return DEFAULT_NAV_LABELS[id] ?? fallback;
}

/**
 * 項目の表示名を設定する。空白だけの入力は「設定済みで空欄」（""）として残す。前後の空白は除く。変えたものを返す
 */
export function setNavLabel(labels: Readonly<Record<string, string>>, id: string, text: string): Record<string, string> {
  return { ...labels, [id]: text.trim() };
}
