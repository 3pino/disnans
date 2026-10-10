// ナビゲーションバーに出すコマンドの並び（端末ごと。lib/stores/navBar.svelte.ts に保存する）
// 項目は本体・プラグインのコマンドの ID（app:open-chat など）。登録されていないもの（外したプラグインなど）は出さないが、並びには残す

export const NAV_CHAT_ID = 'app:open-chat';
export const NAV_THREADS_ID = 'app:open-threads';
export const NAV_SETTINGS_ID = 'app:open-settings';

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
 * 項目を1つ上（dir -1）か下（dir 1）に動かす。動かすのは available にあるもの同士の並びだけで、
 * 登録されていない項目は位置を変えずに残す。端なら変えない
 */
export function moveNavItem(list: readonly string[], available: ReadonlySet<string>, id: string, dir: -1 | 1): string[] {
  const shown = list.filter((x) => available.has(x));
  const i = shown.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= shown.length) return [...list];
  [shown[i], shown[j]] = [shown[j], shown[i]];
  let k = 0;
  return list.map((x) => (available.has(x) ? shown[k++] : x));
}
