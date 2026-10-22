// 添付パネルの「最新の画像」の出どころ。出どころは未定なので、差し替えられる形にしてある（setRecentImageSource）。
// 既定は何も返さない（グリッドは空のまま）。

/** 最近の画像 1 枚。load で添付にできる File を作る（押したときだけ読む） */
export type RecentImage = {
  id: string;
  name: string;
  /** 表示用の小さい画像の URL */
  thumbUrl: string;
  load: () => Promise<File>;
};

/** 最近の画像を新しい順に、最大 limit 件返す */
export type RecentImageSource = (limit: number) => Promise<RecentImage[]>;

/** パネルに並べる件数（グリッド 3 列の 4 行） */
export const RECENT_IMAGE_COUNT = 12;

const NONE: RecentImageSource = async () => [];
let source: RecentImageSource = NONE;

/** 出どころを入れる（null で既定の「何もなし」に戻す） */
export function setRecentImageSource(s: RecentImageSource | null): void {
  source = s ?? NONE;
}

/** 添付パネルに出す最近の画像 */
export function listRecentImages(): Promise<RecentImage[]> {
  return source(RECENT_IMAGE_COUNT);
}
