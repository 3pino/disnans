/**
 * セッションを開いている人（プレゼンス）の純粋な部品。
 * 送る: `session.open` / `session.close`（ClientEvent）。受け取る: `session.presence`（ServerEvent の user_ids）。
 * 同じ人の複数のデバイスは1人。サーバーは、そのセッションを開いている接続にだけ送る。
 */

/** 同じ ID は一度だけ残す（順序は届いた順） */
export function uniqueViewers(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => typeof id === 'string' && id !== ''))];
}

/** 2 つの一覧が同じ人の並びか（順序も見る。変化の通知を重複させないため） */
export function sameViewers(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
