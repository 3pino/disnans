import { ui } from './stores/ui.svelte';
import { requestJump, unread } from './stores/unread.svelte';

/**
 * 未読への移動（コマンド・ホットキーから呼ぶ）。未読はメインチャットだけ（スレッドは廃止した）。
 */

/** いま見ている画面の最初の未読までスクロールする（未読がなければ一番下へ） */
export function jumpToFirstUnread(): void {
  requestJump();
}

/** メインチャットを開き、最初の未読までスクロールする。未読がなければ false */
export function jumpToNextUnread(): boolean {
  if (unread.count === 0) return false;
  // モバイルではパネルがチャットを覆うので閉じる。デスクトップはチャットが横に見えているので閉じない
  ui.showMain();
  requestJump();
  return true;
}
