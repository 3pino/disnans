// 共有フォルダを見る画面（components/FileExplorer.svelte）の決まり。見た目は持たない。

import type { SharedEntry } from './protocol/SharedEntry';
import { isImage } from './fileLink';

/** 並び順: フォルダが先、同じ種類では名前の順（大文字・小文字・数字の桁を区別しない） */
export function sortEntries(entries: Iterable<SharedEntry>): SharedEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, 'ja', { numeric: true, sensitivity: 'base' });
  });
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

/** 項目を押したときの動き: フォルダは中へ、画像は拡大表示、ほかはファイルとして開く・保存する */
export function entryAction(e: SharedEntry): 'enter' | 'image' | 'file' {
  if (e.kind === 'dir') return 'enter';
  return isImage(e.name, e.mime) ? 'image' : 'file';
}
