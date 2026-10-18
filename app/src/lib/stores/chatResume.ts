// Android の復帰（S2）: 背景から戻ったとき、チャットを作り直すかどうか。
// 背景にいた時間が短く、接続が続いていそうなら作り直さない（Rust の受信の見張り（idle）に任せる）。
// 作り直すのは、接続が切れている・まだ始まっていない・長く背景にいた（OS が接続を止めた可能性がある）とき。

/** この時間以上背景にいたら、接続が死んでいるかもしれないとみなして作り直す */
export const RESUME_STALE_MS = 30_000;

export function resumeReconnect(input: { hiddenMs: number; started: boolean; down: boolean }): boolean {
  if (!input.started || input.down) return true;
  return input.hiddenMs >= RESUME_STALE_MS;
}
