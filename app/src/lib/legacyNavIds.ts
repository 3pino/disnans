// 【移行・削除してよい】API 20 で「共有フォルダを開く」（app:open-files）の入口を、コアプラグインの navItem コマンド（plugin-nav:fixplor:files）に置き換えた。
// 保存されていた並び・表示名の旧い ID を、新しい ID に読み替える（読むときに一度だけ変換。書き戻すのは利用者が並べ替えたとき）。
// 次の版で、旧い利用者がいないと判断したら、このファイルと stores/navBar.svelte.ts の呼び出しを消す。
const LEGACY_NAV_ID_MAP: Readonly<Record<string, string>> = { 'app:open-files': 'plugin-nav:fixplor:files' };

/** 並びの旧い ID を新しい ID に読み替える。同じ項目が二つになれば、先のものだけ残す */
export function migrateLegacyNavItems(list: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of list) {
    const next = LEGACY_NAV_ID_MAP[id] ?? id;
    if (!out.includes(next)) out.push(next);
  }
  return out;
}

/** 表示名の旧い ID を新しい ID に読み替える（旧い ID のものが新しい ID になければ、移す） */
export function migrateLegacyNavLabels(labels: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = { ...labels };
  for (const [from, to] of Object.entries(LEGACY_NAV_ID_MAP)) {
    if (Object.hasOwn(out, from)) {
      if (!Object.hasOwn(out, to)) out[to] = out[from];
      delete out[from];
    }
  }
  return out;
}
