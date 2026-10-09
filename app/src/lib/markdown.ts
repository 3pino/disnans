// Markdown サブセット（SPEC 3.1）のパーサー。
// HTML 文字列は作らず、構文木を返す。描画は Svelte 側でテキストノードとして行うので、生 HTML は入り込まない。

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'bold'; children: Inline[] }
  | { type: 'italic'; children: Inline[] }
  | { type: 'link'; href: string; text: string }
  | { type: 'mention'; userId: string };

export type Block =
  | { type: 'paragraph'; lines: Inline[][] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'quote'; children: Block[] }
  | { type: 'list'; ordered: boolean; start: number; items: Inline[][] };

const FENCE = /^ {0,3}```\s*([^`\s]*)\s*$/;
const FENCE_CLOSE = /^ {0,3}```\s*$/;
const QUOTE = /^ {0,3}>( ?)(.*)$/;
const UL = /^ {0,3}[-*+][ \t]+(.*)$/;
const OL = /^ {0,3}(\d{1,9})[.)][ \t]+(.*)$/;

export function parse(src: string): Block[] {
  return parseBlocks(src.replace(/\r\n?/g, '\n').split('\n'));
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE_CLOSE.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // 閉じ（なければ末尾まで）
      blocks.push({ type: 'code', lang: fence[1] ?? '', text: body.join('\n') });
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        const m = QUOTE.exec(lines[i]);
        if (!m) break;
        inner.push(m[2]);
        i++;
      }
      blocks.push({ type: 'quote', children: parseBlocks(inner) });
      continue;
    }

    const ul = UL.exec(line);
    const ol = ul ? null : OL.exec(line);
    if (ul || ol) {
      const ordered = !!ol;
      const re = ordered ? OL : UL;
      const items: Inline[][] = [];
      const start = ol ? parseInt(ol[1], 10) : 1;
      while (i < lines.length) {
        const m = re.exec(lines[i]);
        if (!m) break;
        items.push(parseInline(ordered ? m[2] : m[1]));
        i++;
      }
      blocks.push({ type: 'list', ordered, start, items });
      continue;
    }

    // 段落: 空行・他のブロックの開始まで。改行はそのまま残す
    const para: Inline[][] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === '' || FENCE.test(l) || QUOTE.test(l) || UL.test(l) || OL.test(l)) break;
      para.push(parseInline(l));
      i++;
    }
    blocks.push({ type: 'paragraph', lines: para });
  }
  return blocks;
}

const URL_RE = /^https?:\/\/[^\s<>"'`]+/i;
const MENTION_RE = /^<@([A-Za-z0-9_-]{1,64})>/;
const WORD = /[\p{L}\p{N}]/u;

/** URL の末尾の句読点や、対応しない閉じ括弧は URL に含めない */
function trimUrl(url: string): string {
  let u = url;
  for (;;) {
    const last = u[u.length - 1];
    if (/[.,:;!?。、！？'"]/.test(last)) {
      u = u.slice(0, -1);
      continue;
    }
    if (last === ')') {
      const open = (u.match(/\(/g) ?? []).length;
      const close = (u.match(/\)/g) ?? []).length;
      if (close > open) {
        u = u.slice(0, -1);
        continue;
      }
    }
    return u;
  }
}

/** 強調の閉じを探す。見つからなければ -1 */
function findClose(s: string, from: number, delim: string): number {
  let j = s.indexOf(delim, from);
  while (j !== -1) {
    const before = s[j - 1];
    const after = s[j + delim.length];
    const okSpace = before !== undefined && !/\s/.test(before);
    // `_` は単語の途中（snake_case など）では閉じない
    const okWord = delim !== '_' || after === undefined || !WORD.test(after);
    // `*` の閉じが `**` の一部なら飛ばす
    const okStar = delim !== '*' || (s[j + 1] !== '*' && s[j - 1] !== '*');
    if (j > from && okSpace && okWord && okStar) return j;
    j = s.indexOf(delim, j + 1);
  }
  return -1;
}

export function parseInline(s: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      out.push({ type: 'text', text: buf });
      buf = '';
    }
  };
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    const c = s[i];
    const prev = i > 0 ? s[i - 1] : undefined;

    if ((c === 'h' || c === 'H') && (prev === undefined || !/[A-Za-z0-9]/.test(prev))) {
      const m = URL_RE.exec(rest);
      if (m) {
        const url = trimUrl(m[0]);
        if (url.length > url.indexOf('//') + 2) {
          flush();
          out.push({ type: 'link', href: url, text: url });
          i += url.length;
          continue;
        }
      }
    }

    if (c === '<') {
      const m = MENTION_RE.exec(rest);
      if (m) {
        flush();
        out.push({ type: 'mention', userId: m[1] });
        i += m[0].length;
        continue;
      }
    }

    if (depth < 8) {
      if (rest.startsWith('**') && s[i + 2] !== undefined && !/\s/.test(s[i + 2])) {
        const j = findClose(s, i + 2, '**');
        if (j !== -1) {
          flush();
          out.push({ type: 'bold', children: parseInline(s.slice(i + 2, j), depth + 1) });
          i = j + 2;
          continue;
        }
      }
      if (
        (c === '_' || (c === '*' && s[i + 1] !== '*')) &&
        s[i + 1] !== undefined &&
        !/\s/.test(s[i + 1]) &&
        (c !== '_' || prev === undefined || !WORD.test(prev))
      ) {
        const j = findClose(s, i + 1, c);
        if (j !== -1) {
          flush();
          out.push({ type: 'italic', children: parseInline(s.slice(i + 1, j), depth + 1) });
          i = j + 1;
          continue;
        }
      }
    }

    buf += c;
    i++;
  }
  flush();
  return out;
}

/** 通知などのプレーンテキスト用: メンションを @名前 に置き換える */
export function mentionsToText(body: string, nameOf: (id: string) => string): string {
  return body.replace(/<@([A-Za-z0-9_-]{1,64})>/g, (_, id: string) => '@' + nameOf(id));
}

/** 本文に含まれるメンションの ID */
export function extractMentions(body: string): string[] {
  return [...body.matchAll(/<@([A-Za-z0-9_-]{1,64})>/g)].map((m) => m[1]);
}
