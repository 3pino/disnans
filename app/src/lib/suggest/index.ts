import type { SuggestProvider, Suggestion } from './types';

export type { SuggestItem, SuggestProvider, SuggestRange, Suggestion } from './types';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * キャレットの直前にある `<mark><query>` を探す（`@al` や `:smi` など）。
 * mark の前は行頭・空白・括弧のときだけ（`mail@example` や `12:30` で出さないため）。
 * chars は query に使える1文字の正規表現
 */
export function tokenBefore(
  text: string,
  caret: number,
  mark: string,
  chars: string,
  { min = 0, max = 32 }: { min?: number; max?: number } = {},
): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const re = new RegExp(`(^|[\\s(（])${escapeRe(mark)}(${chars}{${min},${max}})$`);
  const m = re.exec(before);
  if (!m) return null;
  return { start: caret - m[2].length - mark.length, query: m[2] };
}

/** 前方一致を先に、部分一致をあとに並べる */
export function rankByName<T>(list: T[], names: (it: T) => string[], query: string, limit = 8): T[] {
  const q = query.toLowerCase();
  const score = (it: T) => {
    const ns = names(it).map((n) => n.toLowerCase());
    if (ns.some((n) => n.startsWith(q))) return 0;
    if (ns.some((n) => n.includes(q))) return 1;
    return -1;
  };
  return list
    .map((it, i) => ({ it, i, s: q ? score(it) : 0 }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.it);
}

/** 最初に合った出どころの候補を返す。候補が無ければ null */
export function findSuggestion(providers: SuggestProvider[], text: string, caret: number): Suggestion | null {
  for (const p of providers) {
    const range = p.match(text, caret);
    if (!range) continue;
    const items = p.items(text, range);
    if (items.length) return { ...range, label: p.label, items };
  }
  return null;
}

/** 候補を選んだあとの文字列とキャレットの位置 */
export function applySuggestion(text: string, range: { start: number; end: number }, insert: string): { text: string; caret: number } {
  return {
    text: text.slice(0, range.start) + insert + text.slice(range.end),
    caret: range.start + insert.length,
  };
}
