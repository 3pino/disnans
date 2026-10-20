/** 読み直しの最短の間隔（ミリ秒）。ウィンドウに戻るたびに連続で読まないため */
export const REFRESH_MIN_MS = 5_000;

/**
 * 読み直しを、間隔で間引く。allow() は、前回の許可から minMs 以上たっていれば true（そのとき時刻を記録する）。
 * 失敗しても記録は残す（失敗のたびに連打しないため）。
 */
export function createRefreshGate(now: () => number = Date.now, minMs = REFRESH_MIN_MS): { allow(): boolean } {
  let last = -Infinity;
  return {
    allow(): boolean {
      const t = now();
      if (t - last < minMs) return false;
      last = t;
      return true;
    },
  };
}
