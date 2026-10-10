// メッセージ検索の表示まわりの純粋な関数（サーバーの検索と同じく、空白で区切った語をすべて含むものを探す）

/** 一度に取る件数（サーバーの既定と同じ） */
export const SEARCH_PAGE = 30;
/** 入力が止まってから検索を送るまでの時間（ms） */
export const SEARCH_DEBOUNCE_MS = 250;
/** 見出しに出す、一致の前後の文字数 */
const CONTEXT_CHARS = 40;

/** 検索語を空白で区切る（サーバーと同じ） */
export function searchTerms(query: string): string[] {
  return query.trim().split(/\s+/).filter(Boolean);
}

export type Segment = { text: string; hit: boolean };

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 本文から、一致の部分を含む短い見出しを作る（改行は空白にする）。一致の部分は hit: true。
 * 一致がなければ冒頭だけを返す。前後を切ったときは「…」を付ける
 */
export function snippetSegments(text: string, query: string): Segment[] {
  const flat = text.replace(/\s+/g, ' ').trim();
  const terms = searchTerms(query);
  if (terms.length === 0) return [{ text: flat, hit: false }];
  const re = new RegExp(terms.map(escapeRegExp).join('|'), 'giu');
  const first = re.exec(flat);
  const start = first ? Math.max(0, first.index - CONTEXT_CHARS) : 0;
  const end = Math.min(flat.length, start + CONTEXT_CHARS * 2 + (first?.[0].length ?? 0));
  const window = flat.slice(start, end);

  const out: Segment[] = [];
  if (start > 0) out.push({ text: '…', hit: false });
  let last = 0;
  re.lastIndex = 0;
  for (const m of window.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: window.slice(last, at), hit: false });
    out.push({ text: m[0], hit: true });
    last = at + m[0].length;
  }
  if (last < window.length) out.push({ text: window.slice(last), hit: false });
  if (end < flat.length) out.push({ text: '…', hit: false });
  return out;
}
