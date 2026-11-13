// 共有フォルダの項目の URL（一覧・拡大表示・サムネイルの共通）。見た目は持たない。
import { fileUrl, sharedFileUrl } from '../config';
import { isImage, isPdf } from '../fileLink';
import { PDF_THUMB_MAX_BYTES } from '../pdfThumb';
import type { SharedEntry } from '../protocol/SharedEntry';

export function href(e: SharedEntry): string {
  return sharedFileUrl(e.path);
}

/**
 * 読む元の URL（画像・PDF・拡大表示の共通）。ゴミ箱の中の項目（trash あり）は、消えた添付の ID を使わず、
 * いつも共有フォルダのパスで読む（.trash の中身は読める）。ふつうの添付は ID の URL（縮小版は thumb）。ほかは共有フォルダのパス
 */
export function readUrl(e: SharedEntry, thumb = false): string {
  if (!e.trash && e.file_id) return fileUrl(e.file_id, thumb);
  return sharedFileUrl(e.path);
}

/** 並べ目（グリッド）の小さい画像。添付は縮小版（WebP）、共有フォルダの画像は原本。画像でなければ無し */
export function thumbUrl(e: SharedEntry): string | null {
  if (e.kind === 'dir' || !isImage(e.name, e.mime)) return null;
  return readUrl(e, true);
}

/** PDF のサムネイルの元（1 ページ目を描く）。大きすぎる PDF・PDF でなければ無し */
export function pdfSource(e: SharedEntry): { url: string; key: string } | null {
  if (e.kind === 'dir' || !isPdf(e.name, e.mime) || e.size > PDF_THUMB_MAX_BYTES) return null;
  return { url: readUrl(e), key: `${e.path}:${e.modified}:${e.size}` };
}
