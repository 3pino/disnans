// 共有フォルダを見る画面（components/FileExplorer.svelte）の決まり。見た目は持たない。

import type { SharedEntry } from './protocol/SharedEntry';
import { isImage } from './fileLink';
import { viewerKind, type ViewerKind } from './viewers';

/** 並べる key（名前・更新日時・サイズ）と向き */
export type SortKey = 'name' | 'modified' | 'size';
export type SortOrder = 'asc' | 'desc';

const byName = (a: SharedEntry, b: SharedEntry) => a.name.localeCompare(b.name, 'ja', { numeric: true, sensitivity: 'base' });

/**
 * 並び順: フォルダは向きに関係なく先。同じ種類の中を key で並べる（向きは asc・desc）。
 * 同じ値のものは、向きに関係なく名前の順（大文字・小文字・数字の桁を区別しない）
 */
export function sortEntries(entries: Iterable<SharedEntry>, key: SortKey = 'name', order: SortOrder = 'asc'): SharedEntry[] {
  const dir = order === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    if (key === 'name') return byName(a, b) * dir;
    const c = key === 'modified' ? a.modified - b.modified : a.size - b.size;
    // 同じ値の中は、向きに関係なく名前の順
    return c !== 0 ? c * dir : byName(a, b);
  });
}

/** 種類の文字（一覧の「種類」）: フォルダ・画像・拡張子（大文字）・ファイル */
export function kindLabel(e: SharedEntry): string {
  if (e.kind === 'dir') return 'フォルダ';
  if (isImage(e.name, e.mime)) return '画像';
  const dot = e.name.lastIndexOf('.');
  return dot > 0 && dot < e.name.length - 1 ? e.name.slice(dot + 1).toUpperCase() : 'ファイル';
}

/** パン屑（共有フォルダの直下から、いまのフォルダまで）。path は各階層のパス */
export function breadcrumbs(dir: string): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  let acc = '';
  for (const seg of dir === '' ? [] : dir.split('/')) {
    acc = acc === '' ? seg : `${acc}/${seg}`;
    out.push({ name: seg, path: acc });
  }
  return out;
}

/**
 * 項目を押したときの動き: フォルダは中へ（enter）、拡大表示で見られるものはその種類（image・pdf など。lib/viewers.ts）、
 * ほかはファイルとして開く・保存する（file）
 */
export function entryAction(e: SharedEntry): 'enter' | 'file' | ViewerKind {
  if (e.kind === 'dir') return 'enter';
  return viewerKind(e.name, e.mime) ?? 'file';
}
