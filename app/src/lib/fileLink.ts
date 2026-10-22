// 本文のファイルリンク（`[別名](attachments/名前)`・`![…](パス)`）と、添付の表示・操作の決まり。見た目は部品（components）が持つ。

import type { Message } from './protocol/Message';
import type { SharedEntry } from './protocol/SharedEntry';
import { fileUrl, sharedFileUrl } from './config';
import { errorText } from './errors';
import { baseName } from './sharedPath';
import type { FileState } from './stores/sharedIndex.svelte';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;

/** 画像か（添付の mime が無ければ拡張子で見る） */
export function isImage(name: string, mime?: string | null): boolean {
  if (mime) return mime.startsWith('image/');
  return IMAGE_EXT.test(name);
}

/** 削除された添付の名前（消される直前の別名）。本文のリンクが指すものを「削除されたファイル」と見分けるため */
export function deletedAttachmentNames(messages: readonly Message[]): Set<string> {
  const out = new Set<string>();
  for (const m of messages) {
    for (const a of m.attachments) if (a.deleted) out.add(a.file_name.toLowerCase());
  }
  return out;
}

export type FileLinkView =
  /** 確かめ中（一覧を読んでいる） */
  | { kind: 'pending'; text: string }
  /** 見つからない（消えた・名前が違う・読めない） */
  | { kind: 'missing'; text: string }
  /** 削除された添付（名前は出すが開けない） */
  | { kind: 'deleted'; name: string }
  /** フォルダ（リンクにはしない） */
  | { kind: 'folder'; name: string; text: string }
  /** リンク（クリックで開く／保存する） */
  | { kind: 'link'; href: string; name: string; text: string }
  /** 画像のリンク（クリックで拡大表示） */
  | { kind: 'image'; src: string; alt: string; text: string }
  /** 埋め込みの画像 */
  | { kind: 'embedImage'; src: string; alt: string }
  /** 埋め込みのファイル（カード） */
  | { kind: 'embedFile'; href: string; name: string; size: number };

/**
 * ファイルリンク 1 つの表示の決まり。
 * - 見つかった項目は、画像か・フォルダか・埋め込みかで分ける。画像は添付の ID があれば、その URL を使う
 * - 見つからず、同じ名前の削除された添付があれば「削除されたファイル」（一覧に今あるものが優先）
 */
export function fileLinkView(
  link: { path: string; alias: string | null; embed: boolean },
  state: FileState,
  deleted: ReadonlySet<string>,
): FileLinkView {
  const name = baseName(link.path);
  const text = link.alias ?? name;
  if (state.kind === 'loading') return { kind: 'pending', text };
  if (state.kind !== 'found') {
    const wasDeleted = link.path.startsWith('attachments/') && deleted.has(name.toLowerCase());
    return wasDeleted ? { kind: 'deleted', name } : { kind: 'missing', text };
  }
  const entry: SharedEntry = state.entry;
  if (entry.kind === 'dir') return { kind: 'folder', name: entry.name, text };
  const href = sharedFileUrl(link.path);
  const img = isImage(entry.name, entry.mime);
  // 画像は添付の ID があれば、その URL（同じ添付の表示と揃う）。なければ共有フォルダのパス
  const src = img && entry.file_id ? fileUrl(entry.file_id) : href;
  if (!link.embed) {
    return img ? { kind: 'image', src, alt: text, text } : { kind: 'link', href, name: entry.name, text };
  }
  return img ? { kind: 'embedImage', src, alt: entry.name } : { kind: 'embedFile', href, name: entry.name, size: entry.size };
}

/** 添付の名前の変更で、名前に使えない文字（本文のリンクの書き方と衝突する、区切り、改行）。空も使えない。null なら使える */
export function attachmentNameError(name: string): string | null {
  const t = name.trim();
  if (t === '') return '名前を入力してください';
  if (/[/\\[\]|\r\n]/.test(t)) return '名前に / \\ [ ] | と改行は使えません';
  return null;
}

/** 添付の操作（名前の変更・削除）の失敗の文。サーバーの code があれば、その文言（なければサーバーの文） */
export function attachmentActionText(e: unknown): string {
  const code = e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : '';
  const message = e instanceof Error ? e.message : String(e);
  return errorText(code, message);
}
