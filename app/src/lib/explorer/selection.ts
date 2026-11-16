// 共有フォルダの複数選択から決まる値（操作に渡す形・できない理由）。本体は共有の部品（@3pino/explorer-kit の selection）。
// ここは、Disnans の共有フォルダの決まり（SHARED_RULES）を渡して呼ぶ。
import * as kit from '@3pino/explorer-kit';
import type { TransferItem } from '../sharedTransfer';
import { SHARED_RULES } from '../sharedOps';
import type { SharedEntry } from '../protocol/SharedEntry';

export { transferItemOf, allWholeTrash, copyBlockedReason } from '@3pino/explorer-kit';

/** 選んだ項目に、切り取りできないもの（添付のフォルダ・ゴミ箱のフォルダや中身など）があれば、その理由 */
export function cutBlockedReason(items: readonly TransferItem[]): string | null {
  return kit.cutBlockedReason(SHARED_RULES, items);
}

/** 選んだ項目を削除できない理由 */
export function deleteBlockedReason(entries: readonly SharedEntry[], items: readonly TransferItem[]): string | null {
  return kit.deleteBlockedReason(SHARED_RULES, entries, items);
}
