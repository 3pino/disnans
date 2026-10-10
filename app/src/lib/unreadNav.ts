import { threads } from './stores/threads.svelte';
import { ui } from './stores/ui.svelte';
import { MAIN_KEY, nextUnreadKey, requestJump, scopeKey, unread } from './stores/unread.svelte';

/**
 * 未読への移動（コマンド・ホットキーから呼ぶ）。
 *
 * 場所の順番は、メインチャット → スレッド一覧の順（最後に動きがあった順）。
 */

/** いま見ている場所（スレッドのパネルを開いていればそのスレッド、なければメインチャット）のスレッド ID */
export function currentScope(): string | null {
  return ui.panel?.kind === 'thread' ? ui.panel.id : null;
}

function order(): string[] {
  return [MAIN_KEY, ...threads.list.map((t) => t.root.id)];
}

/** 次（`dir = 1`）・前（`dir = -1`）の未読のある場所。メインチャットなら `{ threadId: null }`、なければ null */
export function nextUnreadTarget(dir: 1 | -1 = 1): { threadId: string | null } | null {
  const key = nextUnreadKey(order(), unread.counts, scopeKey(currentScope()), dir);
  if (key === null) return null;
  return { threadId: key === MAIN_KEY ? null : key };
}

/** その場所を開き、最初の未読までスクロールする */
export function openAtFirstUnread(threadId: string | null): void {
  if (threadId === null) {
    // モバイルではスレッドのパネルがチャットを覆うので閉じる。デスクトップはチャットが横に見えているので閉じない
    if (ui.isMobile) ui.closePanel();
    ui.tab = 'chat';
  } else {
    ui.openThread(threadId);
  }
  requestJump(threadId);
}

/** いま見ている場所の最初の未読までスクロールする（未読がなければ一番下へ） */
export function jumpToFirstUnread(): void {
  requestJump(currentScope());
}

/** 次の未読のある場所を開き、最初の未読までスクロールする。未読がなければ false */
export function jumpToNextUnread(): boolean {
  const t = nextUnreadTarget(1);
  if (!t) return false;
  openAtFirstUnread(t.threadId);
  return true;
}

/** 前の未読のある場所を開き、最初の未読までスクロールする。未読がなければ false */
export function jumpToPrevUnread(): boolean {
  const t = nextUnreadTarget(-1);
  if (!t) return false;
  openAtFirstUnread(t.threadId);
  return true;
}
