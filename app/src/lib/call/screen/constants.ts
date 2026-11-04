/** 本体の送り手・設定・プレビューで共有する、画像の選択肢。 */
export type QualityPreset = { readonly label: string; readonly maxEdge: number; readonly quality: number };
export type ColorMode = 'full' | 'c256' | 'gray';
export const QUALITY_PRESETS: Readonly<Record<'p480' | 'p720' | 'p1080', QualityPreset>> = Object.freeze({
  p480: Object.freeze({ label: '480p・品質 50%', maxEdge: 854, quality: 0.5 }),
  p720: Object.freeze({ label: '720p・品質 60%', maxEdge: 1280, quality: 0.6 }),
  p1080: Object.freeze({ label: '1080p・品質 80%', maxEdge: 1920, quality: 0.8 }),
});
export const FPS_OPTIONS: readonly number[] = Object.freeze([5, 20]);
export const COLOR_MODES: Readonly<Record<ColorMode, string>> = Object.freeze({ full: 'フルカラー', c256: '256 色', gray: 'グレースケール' });
/** サーバーの流量制限のうち映像が使う予算（1 回の重さ + payload の KB）。 */
export const SERVER_BUDGET_KBPS = 2400;
