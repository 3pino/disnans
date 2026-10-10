/**
 * メッセージの並び（同じ人の連続した発言をまとめるか）の判定。
 * 一覧（MessageList）で、2つ目以降のアイコン・名前を省くのに使う。
 */

/** この時間内の同じ人の発言は、まとめて1つの連続とみなす */
export const GROUP_MS = 5 * 60_000;

export type RowLike = { author_id: string; created_at: number; thread: unknown | null; bot?: { plugin: string; name: string } | null };

/**
 * `cur` が `prev` の続き（アイコン・名前を省ける）か。
 * `newDay` は、`cur` が日付の変わり目（区切りを出す）かどうか。
 * スレッドの起点（thread を持つ）と、その次の発言はまとめない。
 */
export function isContinuation(prev: RowLike | null, cur: RowLike, newDay: boolean): boolean {
  return (
    !!prev &&
    !newDay &&
    prev.author_id === cur.author_id &&
    // ボットの発言は、ボット（プラグインと名前）が同じ続きだけまとめる
    (prev.bot?.plugin ?? null) === (cur.bot?.plugin ?? null) &&
    (prev.bot?.name ?? null) === (cur.bot?.name ?? null) &&
    cur.created_at - prev.created_at < GROUP_MS &&
    !prev.thread &&
    !cur.thread
  );
}
