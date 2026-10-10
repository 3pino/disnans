import type { Thread } from './protocol/Thread';

/** スレッドの見出し。タイトルがあればそれ、なければ起点のメッセージの冒頭（なければ null） */
export function threadTitle(t: Pick<Thread, 'info'>): string | null {
  return t.info.title?.trim() || null;
}

/** タグの上限（サーバーと同じ） */
export const MAX_TAGS = 10;
export const MAX_TAG_LABEL = 24;
export const MAX_TITLE = 100;
