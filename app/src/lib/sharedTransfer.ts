// 共有フォルダの項目の移動・コピー（「…」の移動・切り取り・コピー、貼り付け）の決まり。見た目は持たない。
// サーバーの決まり（docs/API.md の共有フォルダ）に合わせて先に判定する。最後の判定はサーバー。
// - 共有フォルダと attachments/ の間は移動できない（コピーは可）。attachments/ の中の移動は名前の変更だけ（ファイルのみ）
// - フォルダはコピーできない。フォルダを自分の中へ移せない
// - 同名があれば上書き（必ず確認する）。同名のフォルダがあれば止める（sharedOps の共通規則）

import type { SharedEntry } from './protocol/SharedEntry';
import type { SharedApi } from './transport/shared';
import { attachmentActionText } from './fileLink';
import { baseName } from './sharedPath';
import { ATTACHMENTS_DIR, childPath, inAttachments, nameError, overwriteConfirm, RESERVED_REASON, sameNameEntry } from './sharedOps';

export type TransferOp = 'move' | 'copy';

/** 移動・コピーする項目（パスと種類。バッファにも入る） */
export type TransferItem = { path: string; kind: 'file' | 'dir' };

export type Check = { ok: true } | { ok: false; message: string };

const ok: Check = { ok: true };
const fail = (message: string): Check => ({ ok: false, message });

/** 項目を、移動先のフォルダへ move / copy できるか（サーバーの決まりと同じ） */
export function checkTransfer(op: TransferOp, item: TransferItem, destDir: string): Check {
  if (item.path === ATTACHMENTS_DIR) return fail(RESERVED_REASON);
  if (op === 'move') {
    if (inAttachments(item.path) !== inAttachments(destDir)) return fail('共有フォルダと添付の間は移動できません（コピーしてください）');
    if (item.kind === 'dir' && (destDir === item.path || destDir.startsWith(item.path + '/'))) {
      return fail('フォルダを自分の中へは移せません');
    }
    return ok;
  }
  if (item.kind === 'dir') return fail('フォルダはコピーできません');
  return ok;
}

/** 1 件の貼り付けの決まり */
export type Planned = {
  item: TransferItem;
  /** 先の名前（移動・コピー先の項目名） */
  name: string;
  /** 先のパス（上書きのときは、既存の項目の名前に合わせる） */
  to: string;
  /** create: 作る / overwrite: 上書き（確認する） / skip: 何もしない（同じ場所） / blocked: 止める（message） */
  kind: 'create' | 'overwrite' | 'skip' | 'blocked';
  message?: string;
};

/**
 * 貼り付け・移動の前に、項目ごとの決まりを決める。
 * destEntries は移動先の一覧（読み終えていなければ null。その場合は止める: 同名を黙って上書きしないため）
 */
export function planTransfer(
  op: TransferOp,
  items: readonly TransferItem[],
  destDir: string,
  destEntries: ReadonlyMap<string, SharedEntry> | null,
): Planned[] {
  return items.map((item): Planned => {
    const name = baseName(item.path);
    const to = childPath(destDir, name);
    const blocked = (message: string): Planned => ({ item, name, to, kind: 'blocked', message });
    const c = checkTransfer(op, item, destDir);
    if (!c.ok) return blocked(c.message);
    if (to === item.path) return { item, name, to, kind: 'skip', message: '同じ場所です' };
    const bad = nameError(destDir, name);
    if (bad) return blocked(bad);
    if (!destEntries) return blocked('フォルダの中身を読み終えてから、もう一度試してください');
    const same = sameNameEntry(destEntries, destDir, name);
    if (!same) return { item, name, to, kind: 'create' };
    // 上書きの先は既存の項目の名前（attachments/ は大文字・小文字を区別しない）
    if (same.kind === 'dir') return blocked('同じ名前のフォルダがあります');
    return { item, name, to: childPath(destDir, same.name), kind: 'overwrite' };
  });
}

/**
 * 実行の結果。done: できた / failed: 止めた or 失敗 / skipped: 同じ場所で何もしなかった /
 * declined: 上書きの確認で取り消した（送っていない。切り取りのバッファには残す）
 */
export type TransferResult = {
  done: TransferItem[];
  failed: { item: TransferItem; message: string }[];
  skipped: TransferItem[];
  declined: TransferItem[];
};

export type TransferInput = {
  op: TransferOp;
  items: readonly TransferItem[];
  destDir: string;
  destEntries: ReadonlyMap<string, SharedEntry> | null;
  /** 上書きの確認（ui.confirm を渡す）。false なら、その項目は何もしない */
  confirm: (c: ReturnType<typeof overwriteConfirm>) => Promise<boolean>;
  api: Pick<SharedApi, 'move' | 'copy'>;
  /** 変わったパスを知らせる（一覧の写しを捨てる） */
  invalidate: (path: string) => void;
};

/** 項目を順に移動・コピーする。上書きは 1 件ずつ確認する。失敗しても残りは続ける */
export async function runTransfer(input: TransferInput): Promise<TransferResult> {
  const result: TransferResult = { done: [], failed: [], skipped: [], declined: [] };
  for (const p of planTransfer(input.op, input.items, input.destDir, input.destEntries)) {
    if (p.kind === 'blocked') {
      result.failed.push({ item: p.item, message: p.message ?? '貼り付けられません' });
      continue;
    }
    if (p.kind === 'skip') {
      result.skipped.push(p.item);
      continue;
    }
    if (p.kind === 'overwrite' && !(await input.confirm(overwriteConfirm(p.to)))) {
      result.declined.push(p.item);
      continue;
    }
    try {
      await input.api[input.op](p.item.path, p.to, p.kind === 'overwrite');
      result.done.push(p.item);
      input.invalidate(p.item.path);
      input.invalidate(p.to);
    } catch (e) {
      result.failed.push({ item: p.item, message: attachmentActionText(e) });
    }
  }
  return result;
}

/** 結果の一言（トースト用）。失敗がなければ null */
export function transferFailure(result: TransferResult): string | null {
  if (result.failed.length === 0) return null;
  const first = result.failed[0];
  const more = result.failed.length > 1 ? `（ほか ${result.failed.length - 1} 件）` : '';
  return `「${baseName(first.item.path)}」: ${first.message}${more}`;
}
