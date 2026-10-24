// 添付パネルの「最新の画像」。出どころ（Android は写真アプリの最新、デスクトップはピクチャのフォルダ）は差し替えられる形にしてある。
// 既定の出どころは Tauri の上でだけ使う（ブラウザでは空）。テストは setRecentImageSource で差し替える。

import { isAndroid, isTauri } from './platform';
import { nativeRecentImageSource } from './recentImagesNative';

/** 写真へのアクセスの許可。limited は Android 14 以降の「選んだ写真だけ」 */
export type RecentPermission = 'granted' | 'limited' | 'denied';

/** 最近の画像 1 枚（パネルの表示用）。load は押したときだけ読んで File にする */
export type RecentImage = {
  id: string;
  name: string;
  /** 表示用の小さい画像（data URL）。Rust が作れなかった形式（avif・svg・heic など）は null */
  thumbUrl: string | null;
  /** サムネイルが無いときの表示用の URL（原本を読んで blob URL にする。描けなければ呼び側が名前の枠にする） */
  preview: () => Promise<string>;
  /** 添付にする File（押したときだけ読む） */
  load: () => Promise<File>;
};

/** 一覧の結果。許可が無いときは images は空 */
export type RecentImages = { permission: RecentPermission; images: RecentImage[] };

/** 出どころ。list は新しい順に、最大 limit 件（1〜60）返す */
export type RecentImageSource = {
  list: (limit: number) => Promise<RecentImages>;
  /** 許可を求める（初回のパネルを開いたときだけ呼ぶ。ダイアログが出うる） */
  requestPermission: () => Promise<RecentPermission>;
};

/** タイル（正方形）の幅の最小・最大（px）。列数は幅から決め、タイルの幅はこの間に収める */
export const RECENT_TILE_MIN = 96;
export const RECENT_TILE_MAX = 140;
/** 並べる件数の上限。実際の件数は、画面の半分の高さに入るだけ（小さい画面では少なくなる） */
export const RECENT_IMAGE_MAX = 24;

/** 枠の決まり（列数・タイルの幅・行数・入る件数） */
export type RecentGridFit = { cols: number; tile: number; rows: number; capacity: number };

/**
 * 幅・最大の高さ・隙間から、タイルの列数と大きさを決め、高さに入る行数（1 行は必ず取る）と件数（上限まで）を返す。
 * 幅が分からないとき（0）は、上限の件数を返す（列数は 1）
 */
export function recentGridFit(o: {
  width: number;
  maxHeight: number;
  gap: number;
  min?: number;
  max?: number;
  limit?: number;
}): RecentGridFit {
  const min = o.min ?? RECENT_TILE_MIN;
  const max = o.max ?? RECENT_TILE_MAX;
  const limit = o.limit ?? RECENT_IMAGE_MAX;
  if (o.width <= 0) return { cols: 1, tile: min, rows: 1, capacity: limit };
  const cols = Math.max(1, Math.floor((o.width + o.gap) / (min + o.gap)));
  const tile = Math.floor(Math.min(max, (o.width - (cols - 1) * o.gap) / cols));
  const rows = Math.max(1, Math.floor((o.maxHeight + o.gap) / (tile + o.gap)));
  return { cols, tile, rows, capacity: Math.min(limit, cols * rows) };
}

const NONE: RecentImageSource = {
  list: async () => ({ permission: 'granted', images: [] }),
  requestPermission: async () => 'granted',
};

let override: RecentImageSource | null = null;

/** 出どころを差し替える（null で既定に戻す） */
export function setRecentImageSource(s: RecentImageSource | null): void {
  override = s;
}

/** いまの出どころ: 差し替えたもの、なければ Tauri の出どころ（Android かデスクトップか）、ブラウザは空 */
function current(): RecentImageSource {
  if (override) return override;
  if (!isTauri()) return NONE;
  return nativeRecentImageSource(isAndroid() ? 'android' : 'desktop');
}

/** 添付パネルに出す最近の画像と、写真の許可 */
export function listRecentImages(count: number = RECENT_IMAGE_MAX): Promise<RecentImages> {
  return current().list(count);
}

/** 写真の許可を求める（初回のパネルを開いたときだけ） */
export function requestRecentImagesPermission(): Promise<RecentPermission> {
  return current().requestPermission();
}

/** 許可の案内（denied・limited のときパネルに出す文）。設定の場所は Android の文 */
export function permissionNotice(permission: RecentPermission): string | null {
  if (permission === 'denied') {
    return '写真へのアクセスが許可されていないため、最近の画像は出せません。設定 > アプリ > disnans > 権限 で写真の許可を与えると表示されます';
  }
  if (permission === 'limited') {
    return '選んだ写真だけを表示しています。すべての写真を表示するには、設定 > アプリ > disnans > 権限 で変更してください';
  }
  return null;
}
