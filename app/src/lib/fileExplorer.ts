// 共有フォルダを見る画面の決まり。見た目は持たない。本体は共有の部品（@3pino/explorer-kit の listing）。
// 種類の見分け（画像・拡大表示で見られるもの）は Disnans の決まり（fileLink・viewers）を渡す。

import * as kit from '@3pino/explorer-kit';
import type { SharedEntry } from './protocol/SharedEntry';
import { isImage } from './fileLink';
import { viewerKind, type ViewerKind } from './viewers';

export { sortEntries, breadcrumbs } from '@3pino/explorer-kit';
export type { SortKey, SortOrder } from '@3pino/explorer-kit';

/** 種類の文字（一覧の「種類」）: フォルダ・画像・拡張子（大文字）・ファイル */
export function kindLabel(e: SharedEntry): string {
  return kit.kindLabel(e, isImage);
}

/**
 * 項目を押したときの動き: フォルダは中へ（enter）、拡大表示で見られるものはその種類（image・pdf など。lib/viewers.ts）、
 * ほかはファイルとして開く・保存する（file）
 */
export function entryAction(e: SharedEntry): 'enter' | 'file' | ViewerKind {
  return kit.entryAction(e, viewerKind) as 'enter' | 'file' | ViewerKind;
}
