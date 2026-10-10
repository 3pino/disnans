// メッセージ検索の表示まわりの純粋な関数（サーバーの検索と同じく、空白で区切った語をすべて含むものを探す）

/** 一度に取る件数（サーバーの既定と同じ） */
export const SEARCH_PAGE = 30;
/** 入力が止まってから検索を送るまでの時間（ms） */
export const SEARCH_DEBOUNCE_MS = 250;

/** 検索語を空白で区切る（サーバーと同じ） */
export function searchTerms(query: string): string[] {
  return query.trim().split(/\s+/).filter(Boolean);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 本文の中の、検索語に一致する範囲 [開始, 終了)（大文字・小文字は区別しない。重なりはない） */
export function matchRanges(text: string, query: string): [number, number][] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  // 長い語を先に試して、短い語が長い語の一部だけを拾わないようにする
  const re = new RegExp(
    terms
      .slice()
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join('|'),
    'giu',
  );
  const out: [number, number][] = [];
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    out.push([at, at + m[0].length]);
  }
  return out;
}

/** サーバーは新しい順に返す。チャットと同じ並び（古いものが上）にする */
export function chronological<T>(newestFirst: readonly T[]): T[] {
  return [...newestFirst].reverse();
}

/** 次のページ（さらに古いもの）を足す。すでにあるものは重ねない */
export function appendOlder<T extends { id: string }>(hits: readonly T[], page: readonly T[]): T[] {
  const seen = new Set(hits.map((h) => h.id));
  return [...hits, ...page.filter((m) => !seen.has(m.id))];
}
