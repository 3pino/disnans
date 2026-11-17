// 共有フォルダの書き込みの決まり（名前・確認の文・同名の扱い）。見た目は持たない。
// 決まりの本体は共有の部品（@3pino/explorer-kit の ops）。ここは、Disnans の共有フォルダの決まり（SHARED_RULES:
// 添付のフォルダ attachments/・名前の決まり）を渡して呼ぶ。
// 添付（attachments/ の中）は本文のリンクと結びつくので、確認の文にその旨を入れる。

import * as kit from '@3pino/explorer-kit';
import type { Rules } from '@3pino/explorer-kit';
import type { SharedEntry } from './protocol/SharedEntry';
import { attachmentNameError } from './fileLink';

export { childPath, renameTarget } from '@3pino/explorer-kit';
export type { Allowed, UploadPlan } from '@3pino/explorer-kit';

export const ATTACHMENTS_DIR = 'attachments';

/** attachments/ そのものか、その中か（添付の決まりが掛かる） */
export function inAttachments(path: string): boolean {
  return path === ATTACHMENTS_DIR || path.startsWith(ATTACHMENTS_DIR + '/');
}

/** Windows で使えない名前（予約名。拡張子があっても同じ） */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * 共有フォルダの名前の決まり（サーバーが最後に判定する。ここでは分かりやすい形で先に出す）。null なら使える。
 * attachments/ の中は、本文のリンクの書き方と衝突する文字（[ ] |）も使えない
 */
export function nameError(dir: string, name: string): string | null {
  if (inAttachments(dir)) {
    const a = attachmentNameError(name);
    if (a) return a;
  }
  if (name.trim() === '') return '名前を入力してください';
  if (name === '.' || name === '..') return 'この名前は使えません';
  if (/[\\/:*?"<>|]/.test(name) || /[\u0000-\u001f]/.test(name)) return '名前に \\ / : * ? " < > | と改行は使えません';
  if (name.endsWith('.') || name.endsWith(' ')) return '名前の末尾に . や空白は使えません';
  if (name.startsWith('.disnans-')) return 'この名前は使えません';
  if (RESERVED.test(name)) return 'この名前は Windows で使えません';
  return null;
}

/** Disnans の共有フォルダの決まり（エクスプローラーの部品へ渡す） */
export const SHARED_RULES: Rules = {
  specialDir: ATTACHMENTS_DIR,
  nameError,
  // 共有の部品は一般の文しか持たないので、Disnans の言葉（共有フォルダ・添付・本文のリンク）はここで渡す
  texts: {
    root: '共有フォルダ',
    reserved: '添付のフォルダは動かせません',
    crossMove: '共有フォルダと添付の間は移動できません（コピーしてください）',
    noSubfolder: '添付フォルダ内にフォルダは作れません',
    cutSkipped: '添付・ゴミ箱のフォルダは動かせないので除きました',
    trashNote: '添付のものは、本文のリンクが「削除されたファイル」になります',
    overwriteBody: '同じ添付の中身が入れ替わります。本文の表示も新しい中身になります。元に戻せません',
  },
};

/** 項目の操作（名前の変更・削除）を出すか。attachments/ そのもの（仮想のフォルダ）は動かさない */
export function canOperate(path: string): boolean {
  return path !== ATTACHMENTS_DIR;
}

/** 項目の名前の変更・削除の可否（attachments/ そのものだけ不可。サーバーの決まり） */
export function renameAllowed(path: string): kit.Allowed {
  return kit.renameAllowed(SHARED_RULES, path);
}

/** 複数の項目をゴミ箱に移す確認の文 */
export function trashManyConfirm(items: readonly { path: string; kind: 'file' | 'dir' }[]): { title: string; body: string; okLabel: string; danger: true } {
  return kit.trashManyConfirm(SHARED_RULES, items);
}

/** 同名のファイルを上書きする確認の文（必ず確認する）。attachments/ の中は、本文の表示も新しい中身になる */
export function overwriteConfirm(path: string): { title: string; body: string; okLabel: string; danger: true } {
  return kit.overwriteConfirm(SHARED_RULES, path);
}

/** 一覧の中の、同じ名前の項目。attachments/ は大文字・小文字を区別しない（添付の別名の決まり） */
export function sameNameEntry(entries: ReadonlyMap<string, SharedEntry>, dir: string, name: string): SharedEntry | undefined {
  return kit.sameNameEntry(SHARED_RULES, entries, dir, name) as SharedEntry | undefined;
}

/**
 * アップロードの前に、同名の扱いを決める。
 * - 一覧が手元にない（読み終えていない）ときは上書きを防ぐため止める（PUT は同名を黙って上書きするため）
 * - 同名がフォルダなら止める。ファイルなら上書き（呼ぶ側で確認する）
 */
export function planUpload(dir: string, name: string, state: { kind: string; entries?: ReadonlyMap<string, SharedEntry> }): kit.UploadPlan {
  return kit.planUpload(SHARED_RULES, dir, name, state);
}
