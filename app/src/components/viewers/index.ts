// 拡大表示のビューアーの部品（種類 → 部品）。種類の見分け方は lib/viewers.ts。
// 新しい種類を足すときは、ViewerProps を受ける部品を作り、ここに登録する

import type { Component } from 'svelte';
import type { ViewerKind, ViewerProps } from '../../lib/viewers';
import ImageViewer from './ImageViewer.svelte';
import PdfViewer from './PdfViewer.svelte';

export const VIEWERS: Record<ViewerKind, Component<ViewerProps>> = {
  image: ImageViewer,
  pdf: PdfViewer,
};
