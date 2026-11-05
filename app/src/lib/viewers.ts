// 拡大表示（全画面。components/Lightbox.svelte）で見られるファイルの種類。
// 種類ごとのビューアーの部品は components/viewers/index.ts。新しい種類を足すときは、
// 1. ここの VIEWER_RULES に見分け方を足す 2. components/viewers/ に ViewerProps を受ける部品を作り、index.ts に登録する
// だけでよい（前後の切り替え・スワイプ・キー操作・ダウンロード・閉じるは Lightbox が受け持つ）

import { isImage, isPdf } from './fileLink';

export type ViewerKind = 'image' | 'pdf';

/** 見分け方（上から順に見る） */
const VIEWER_RULES: { kind: ViewerKind; match: (name: string, mime?: string | null) => boolean }[] = [
  { kind: 'image', match: isImage },
  { kind: 'pdf', match: isPdf },
];

/** このファイルを拡大表示で見られるなら、その種類（見られなければ null） */
export function viewerKind(name: string, mime?: string | null): ViewerKind | null {
  return VIEWER_RULES.find((r) => r.match(name, mime))?.kind ?? null;
}

/**
 * 背景・画像のタップの扱い。
 * - 'close'（既定）: 等倍のときの 1 回のタップで閉じる（写真・PDF の従来の動き）
 * - 'media': 画像の上のタップは onimagetap を呼んで閉じない（ライブの映像で、タップで操作を出すため）。画像の外のタップは 'close' と同じ
 */
export type TapMode = 'close' | 'media';

/**
 * ビューアーの部品が受け取るもの。
 * - 拡大・縮小・移動はビューアーが受け持ち、等倍か（zoomed）を onzoom で知らせる。
 *   等倍のときは、1 本指の左右の動き・←→ キーを Lightbox が前後の切り替えに使う（ビューアーは受けない）
 * - active でないもの（スワイプで隣に見えている前後のファイル）は、操作を受けず、等倍に戻しておく
 */
export type ViewerProps = {
  src: string;
  alt: string;
  /** いま見ているものか（前後の隣のものは false） */
  active: boolean;
  /** 等倍から拡大した・等倍に戻した */
  onzoom?: (zoomed: boolean) => void;
  /** 等倍のときに、背景を 1 回タップした（Lightbox は閉じる） */
  ontap?: () => void;
  /** タップの扱い（既定 'close'。部品によっては無視する） */
  tapMode?: TapMode;
  /** tapMode が 'media' のとき、画像の上を 1 回タップした（ダブルタップは拡大に使うので呼ばない。拡大中も呼ぶ） */
  onimagetap?: () => void;
};
