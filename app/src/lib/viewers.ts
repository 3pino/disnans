// 拡大表示で見られるファイルの種類（disnans の見分け方）。部品と型は @3pino/viewer-kit-web/viewers。
// 新しい種類を足すときは、ここの VIEWER_RULES に見分け方を足し、部品を components/Lightbox.svelte の viewers に登録する

import { isImage, isPdf } from './fileLink';
import type { ViewerKind } from '@3pino/viewer-kit-web/viewers/types';

export type { ViewerKind, TapMode, ViewerProps } from '@3pino/viewer-kit-web/viewers/types';

/** 見分け方（上から順に見る） */
const VIEWER_RULES: { kind: ViewerKind; match: (name: string, mime?: string | null) => boolean }[] = [
  { kind: 'image', match: isImage },
  { kind: 'pdf', match: isPdf },
];

/** このファイルを拡大表示で見られるなら、その種類（見られなければ null） */
export function viewerKind(name: string, mime?: string | null): ViewerKind | null {
  return VIEWER_RULES.find((r) => r.match(name, mime))?.kind ?? null;
}
