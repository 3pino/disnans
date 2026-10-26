// 共有フォルダの書き込みの決まり（名前・確認の文・同名の扱い）。見た目は持たない（components/FileExplorer・SharedEntryActions）。
// 添付（attachments/ の中）は本文のリンクと結びつくので、確認の文にその旨を入れる。

import type { SharedEntry } from './protocol/SharedEntry';
import { attachmentNameError } from './fileLink';
import { baseName, parentOf } from './sharedPath';

export const ATTACHMENTS_DIR = 'attachments';

/** attachments/ そのものか、その中か（添付の決まりが掛かる） */
export function inAttachments(path: string): boolean {
  return path === ATTACHMENTS_DIR || path.startsWith(ATTACHMENTS_DIR + '/');
}

/** 直下の子のパス（dir が空なら名前だけ） */
export function childPath(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
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

/** 項目の操作（名前の変更・削除）を出すか。attachments/ そのもの（仮想のフォルダ）は動かさない */
export function canOperate(path: string): boolean {
  return path !== ATTACHMENTS_DIR;
}

/** 添付のフォルダ（attachments/ そのもの）の理由。動かせない・消せない（サーバーの決まり: 403） */
export const RESERVED_REASON = '添付のフォルダは動かせません';

/** 項目の操作（名前の変更・切り取り・削除）が、今できるか。できないときは理由 */
export type Allowed = { ok: true } | { ok: false; message: string };

/** 項目の名前の変更・削除の可否（attachments/ そのものだけ不可。サーバーの決まり） */
export function renameAllowed(path: string): Allowed {
  return path === ATTACHMENTS_DIR ? { ok: false, message: RESERVED_REASON } : { ok: true };
}

/** 削除の確認の文（ui.confirm に渡す形）。attachments/ の中は本文のリンクが「削除されたファイル」になる */
export function deleteConfirm(path: string, dir: boolean): { title: string; body: string; okLabel: string; danger: true } {
  const name = baseName(path);
  if (inAttachments(path)) {
    return {
      title: `「${name}」を削除しますか`,
      body: '本文のリンクは「削除されたファイル」になります。元に戻せません',
      okLabel: '削除',
      danger: true,
    };
  }
  if (dir) {
    return { title: `フォルダ「${name}」を削除しますか`, body: '中身もすべて消えます。元に戻せません', okLabel: '削除', danger: true };
  }
  return { title: `「${name}」を削除しますか`, body: '元に戻せません', okLabel: '削除', danger: true };
}

/** 複数の項目の削除の確認の文（まとめて 1 回。attachments/ の中・フォルダが混じるときは、その旨を入れる） */
export function deleteManyConfirm(items: readonly { path: string; kind: 'file' | 'dir' }[]): { title: string; body: string; okLabel: string; danger: true } {
  const n = items.length;
  const notes: string[] = [];
  if (items.some((i) => inAttachments(i.path))) notes.push('添付のものは、本文のリンクが「削除されたファイル」になります');
  if (items.some((i) => i.kind === 'dir')) notes.push('フォルダは中身もすべて消えます');
  notes.push('元に戻せません');
  return { title: `${n} 件を削除しますか`, body: notes.join('。'), okLabel: '削除', danger: true };
}

/** 同名のファイルを上書きする確認の文（必ず確認する）。attachments/ の中は、本文の表示も新しい中身になる */
export function overwriteConfirm(path: string): { title: string; body: string; okLabel: string; danger: true } {
  const name = baseName(path);
  return {
    title: `「${name}」を上書きしますか`,
    body: inAttachments(path)
      ? '同じ添付の中身が入れ替わります。本文の表示も新しい中身になります。元に戻せません'
      : '今のファイルは消えて、新しいものに入れ替わります。元に戻せません',
    okLabel: '上書き',
    danger: true,
  };
}

/** 一覧の中の、同じ名前の項目。attachments/ は大文字・小文字を区別しない（添付の別名の決まり） */
export function sameNameEntry(
  entries: ReadonlyMap<string, SharedEntry>,
  dir: string,
  name: string,
): SharedEntry | undefined {
  const exact = entries.get(name);
  if (exact || !inAttachments(dir)) return exact;
  const lower = name.toLowerCase();
  for (const [k, v] of entries) if (k.toLowerCase() === lower) return v;
  return undefined;
}

/** アップロード（作成・上書き）の決め方 */
export type UploadPlan =
  | { kind: 'create'; path: string }
  | { kind: 'overwrite'; path: string }
  | { kind: 'blocked'; message: string };

/**
 * アップロードの前に、同名の扱いを決める。
 * - 一覧が手元にない（読み終えていない）ときは上書きを防ぐため止める（PUT は同名を黙って上書きするため）
 * - 同名がフォルダなら止める。ファイルなら上書き（呼ぶ側で確認する）
 */
export function planUpload(dir: string, name: string, state: { kind: string; entries?: ReadonlyMap<string, SharedEntry> }): UploadPlan {
  const path = childPath(dir, name);
  const bad = nameError(dir, name);
  if (bad) return { kind: 'blocked', message: bad };
  if (state.kind !== 'ok' || !state.entries) return { kind: 'blocked', message: 'フォルダの中身を読み終えてから、もう一度送ってください' };
  const same = sameNameEntry(state.entries, dir, name);
  if (!same) return { kind: 'create', path };
  if (same.kind === 'dir') return { kind: 'blocked', message: '同じ名前のフォルダがあります' };
  return { kind: 'overwrite', path: childPath(dir, same.name) };
}

/** 項目の親のフォルダ（名前の変更の先） */
export function renameTarget(path: string, to: string): string {
  return childPath(parentOf(path), to);
}
