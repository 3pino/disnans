// 共有フォルダの項目の移動・コピー（「…」の移動・切り取り・コピー、貼り付け）の決まり。見た目は持たない。
// 決まりの本体は共有の部品（@3pino/explorer-kit の transfer）。ここは、Disnans の共有フォルダの決まり（SHARED_RULES）と、
// 失敗の文（attachmentActionText）を渡して呼ぶ。サーバーの決まり（docs/api/shared-folder.md）に合わせて先に判定する。最後の判定はサーバー。
// - 共有フォルダと attachments/ の間は移動できない（コピーは可）。attachments/ の中の移動は名前の変更だけ（ファイルのみ）
// - フォルダを自分の中へは移動・コピーできない
// - 同名があれば上書き（必ず確認する）。同名のフォルダがあれば止める（sharedOps の共通規則）

import * as kit from '@3pino/explorer-kit';
import type { SharedEntry } from './protocol/SharedEntry';
import { attachmentActionText } from './fileLink';
import { SHARED_RULES } from './sharedOps';

export { transferFailure } from '@3pino/explorer-kit';
export type { TransferOp, TransferItem, Check, Planned, TransferResult } from '@3pino/explorer-kit';

/** 項目を、移動先のフォルダへ move / copy できるか（サーバーの決まりと同じ） */
export function checkTransfer(op: kit.TransferOp, item: kit.TransferItem, destDir: string): kit.Check {
  return kit.checkTransfer(SHARED_RULES, op, item, destDir);
}

/**
 * 貼り付け・移動の前に、項目ごとの決まりを決める。
 * destEntries は移動先の一覧（読み終えていなければ null。その場合は止める: 同名を黙って上書きしないため）
 */
export function planTransfer(
  op: kit.TransferOp,
  items: readonly kit.TransferItem[],
  destDir: string,
  destEntries: ReadonlyMap<string, SharedEntry> | null,
): kit.Planned[] {
  return kit.planTransfer(SHARED_RULES, op, items, destDir, destEntries);
}

export type TransferInput = Omit<kit.TransferInput, 'rules' | 'errorText'>;

/** 項目を順に移動・コピーする。上書きは 1 件ずつ確認する。失敗しても残りは続ける */
export function runTransfer(input: TransferInput): Promise<kit.TransferResult> {
  return kit.runTransfer({ ...input, rules: SHARED_RULES, errorText: attachmentActionText });
}
