// ゴミ箱の仮想フォルダ（`.trash/`）の見え方と決まり。見た目は持たない（components/FileExplorer が使う）。
// 中身の種類は、サーバーが一覧の `trash` に入れた印（SharedEntry.trash）で決める。パスや名前から推測しない。
//  - root: `.trash/` そのもの（一覧の '' に出る）。コピー・移動・削除・名前の変更はできない
//  - item: `.trash/<ID>--<元の名前>` の直下の 1 件（ゴミ箱の 1 件）。元の名前は entry.original_path から出す。
//          読む・コピー（元の名前で）・元へ戻す・完全削除ができる。名前は変えられない
//  - descendant: 1 件の中のフォルダ・ファイル。読む・コピーだけ。書き込みは不可
// 実在の `.trash` フォルダ（仮想が無効なとき）は、ふつうのフォルダとして扱う。

import type { SharedEntry } from './protocol/SharedEntry';
import type { SharedTrashEntry } from './protocol/SharedTrashEntry';
import { baseName, parentOf } from './sharedPath';
import type { DirState } from './stores/sharedIndex.svelte';

/** 仮想のゴミ箱フォルダの名前（共有フォルダの直下） */
export const TRASH_ROOT = '.trash';

/** 直下の 1 件（ゴミ箱の項目）の元の名前。ほかの項目は、名前そのもの */
export function entryLabel(e: SharedEntry): string {
  return e.trash?.kind === 'item' ? baseName(e.trash.entry.original_path) : e.name;
}

/**
 * 表示用の項目。ゴミ箱の直下の項目は、名前だけ元の名前に置き換える（path と name の元の値は、そのまま要求に使う）。
 * ほかの項目は、そのまま返す
 */
export function displayEntry(e: SharedEntry): SharedEntry {
  return e.trash?.kind === 'item' ? { ...e, name: entryLabel(e) } : e;
}

/** ゴミ箱の 1 件（直下の項目）の中身。直下の項目でなければ null */
export function trashItemOf(e: SharedEntry): SharedTrashEntry | null {
  return e.trash?.kind === 'item' ? e.trash.entry : null;
}

/** 項目の種類（ゴミ箱の中での位置） */
export type TrashPlace = 'root' | 'item' | 'inside' | 'normal';

export function trashPlace(e: SharedEntry): TrashPlace {
  switch (e.trash?.kind) {
    case 'root': return 'root';
    case 'item': return 'item';
    case 'descendant': return 'inside';
    default: return 'normal';
  }
}

/**
 * フォルダ（dir）が、仮想のゴミ箱の中か。
 * - normal: ふつうのフォルダ（実在の `.trash` を含む）
 * - root: `.trash/` そのもの
 * - inside: `.trash/` の中（1 件の中身を含む）
 * - unknown: `.trash/` の中かもしれないが、まだ確かめられない（書き込みは止める）
 * 判定は、共有フォルダの直下の一覧にある `.trash` の印（trash.kind === 'root'）で決める。
 * root の一覧（rootState）が手元に無いときは、`.trash` の下なら unknown。
 */
export type VirtualDir = 'normal' | 'root' | 'inside' | 'unknown';

export function virtualDir(dir: string, rootState: DirState | undefined): VirtualDir {
  if (dir !== TRASH_ROOT && !dir.startsWith(TRASH_ROOT + '/')) return 'normal';
  if (rootState?.kind !== 'ok') return 'unknown';
  const root = rootState.entries.get(TRASH_ROOT);
  if (root?.trash?.kind !== 'root') return 'normal';
  return dir === TRASH_ROOT ? 'root' : 'inside';
}

/** 書き込みを止める理由（ふつうのフォルダなら null） */
export function writeBlockReason(v: VirtualDir): string | null {
  if (v === 'normal') return null;
  if (v === 'unknown') return 'ゴミ箱の場所を確かめています。もう一度お試しください';
  return 'ゴミ箱の中には書き込めません';
}

/** 直下の項目の、元の場所（親のフォルダ）。元の名前への移動（戻す）の先に使う */
export function restoreParent(e: SharedEntry): string | null {
  const t = trashItemOf(e);
  return t ? parentOf(t.original_path) : null;
}
