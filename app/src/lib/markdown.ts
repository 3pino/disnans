// Markdown サブセット（SPEC 3.1）のパーサー。
// HTML 文字列は作らず、構文木を返す。描画は Svelte 側でテキストノードとして行うので、生 HTML は入り込まない。

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'bold'; children: Inline[] }
  | { type: 'italic'; children: Inline[] }
  | { type: 'underline'; children: Inline[] }
  | { type: 'strike'; children: Inline[] }
  | { type: 'highlight'; children: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; text: string }
  | { type: 'mention'; userId: string };

/** リストの1項目。1行目以降の段落行は lines に、入れ子のブロック（リスト・引用など）は children に入る */
export type ListItem = { lines: Inline[][]; children: Block[] };

export type Block =
  | { type: 'paragraph'; lines: Inline[][] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'quote'; children: Block[] }
  | { type: 'list'; ordered: boolean; start: number; items: ListItem[] };

const FENCE = /^ {0,3}```\s*([^`\s]*)\s*$/;
const FENCE_CLOSE = /^ {0,3}```\s*$/;
const QUOTE = /^ {0,3}>( ?)(.*)$/;
// 箇条書き・番号付きの共通の形。[1]=インデント [2]=記号 [3]=記号の後の空白 [4]=中身
const LIST = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/;

export function parse(src: string): Block[] {
  return parseBlocks(src.replace(/\r\n?/g, '\n').split('\n'));
}

/** タブは 4 桁として数える */
function colsOf(ws: string): number {
  let n = 0;
  for (const ch of ws) n += ch === '\t' ? 4 : 1;
  return n;
}

function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? '';
}

/** 行頭から最大 n 桁ぶんの空白を取り除く */
function stripIndent(line: string, n: number): string {
  let col = 0;
  let k = 0;
  while (k < line.length && col < n) {
    const ch = line[k];
    if (ch === ' ') {
      col += 1;
    } else if (ch === '\t') {
      if (col + 4 > n) return ' '.repeat(col + 4 - n) + line.slice(k + 1);
      col += 4;
    } else {
      break;
    }
    k++;
  }
  return line.slice(k);
}

function isOrderedMarker(marker: string): boolean {
  return /\d/.test(marker);
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

    const first = LIST.exec(line);
    if (first) {
      const r = parseList(lines, i, first);
      blocks.push(r.block);
      i = r.next;
      continue;
    }

    // 段落: 空行・他のブロックの開始まで。改行はそのまま残す
    const para: Inline[][] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === '' || FENCE.test(l) || QUOTE.test(l) || LIST.test(l)) break;
      para.push(parseInline(l));
      i++;
    }
    blocks.push({ type: 'paragraph', lines: para });
  }
  return blocks;
}

/**
 * リストを読む。項目の下に続く、先頭より深くインデントされた行は、その項目の中身になる。
 * 同じインデントで同じ種類の記号が来たら次の項目。空行を挟んでもリストは続く。
 */
function parseList(lines: string[], start: number, first: RegExpExecArray): { block: Block; next: number } {
  const baseIndent = colsOf(first[1]);
  const ordered = isOrderedMarker(first[2]);
  const startNum = ordered ? parseInt(first[2], 10) : 1;
  const items: ListItem[] = [];
  let m = first;
  let i = start;
  for (;;) {
    // 項目の中身の桁。これより深い行は、この項目の続き（入れ子）として扱う
    const contentIndent = colsOf(m[1]) + m[2].length + colsOf(m[3]);
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j];
      if (l.trim() === '') {
        body.push('');
        j++;
        continue;
      }
      if (colsOf(indentOf(l)) <= baseIndent) break;
      body.push(stripIndent(l, contentIndent));
      j++;
    }
    // 末尾の空行は項目の外（次の項目との間）
    while (body.length > 0 && body[body.length - 1] === '') {
      body.pop();
      j--;
    }

    const sub = parseBlocks(body);
    const lineNodes: Inline[][] = [parseInline(m[4])];
    let children = sub;
    // 項目の直後に続く段落行（空行なし）は、項目の文の続きとして同じ項目の行にまとめる
    if (body.length > 0 && body[0] !== '' && sub[0]?.type === 'paragraph') {
      lineNodes.push(...sub[0].lines);
      children = sub.slice(1);
    }
    items.push({ lines: lineNodes, children });

    let k = j;
    while (k < lines.length && lines[k].trim() === '') k++;
    const next = k < lines.length ? LIST.exec(lines[k]) : null;
    if (next && colsOf(next[1]) === baseIndent && isOrderedMarker(next[2]) === ordered) {
      m = next;
      i = k;
      continue;
    }
    return { block: { type: 'list', ordered, start: startNum, items }, next: j };
  }
}

const URL_Y = /https?:\/\/[^\s<>"'`]+/iy;
const MENTION_Y = /<@([A-Za-z0-9_-]{1,64})>/y;
const HTTP_HREF = /^https?:\/\/[^\s<>"'`]+$/i;
const ASCII_PUNCT = /[!-\/:-@\[-`{-~]/;
/** `_` の強調では、英数字と `_` の隣は単語の途中とみなす（snake_case・a__b__c） */
const UNDERSCORE_WORD = /[\p{L}\p{N}_]/u;

/** 2文字の記号で囲む強調。順に試す（`__` は `_` より先） */
const DOUBLE: ReadonlyArray<readonly [string, 'bold' | 'strike' | 'underline' | 'highlight']> = [
  ['**', 'bold'],
  ['~~', 'strike'],
  ['__', 'underline'],
  ['==', 'highlight'],
];

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

/**
 * 位置 i から始まる「かたまり」（強調の記号を解釈しない部分）。
 * エスケープ・コード・リンク・メンション・URL。強調の閉じ探しでも飛ばす。
 */
type Atom = { len: number; node?: Inline; text?: string };

function atomAt(s: string, i: number): Atom | null {
  const c = s[i];
  if (c === '\\') {
    const next = s[i + 1];
    if (next !== undefined && ASCII_PUNCT.test(next)) return { len: 2, text: next };
    return null;
  }
  if (c === '`') {
    const close = s.indexOf('`', i + 1);
    if (close > i + 1) return { len: close - i + 1, node: { type: 'code', text: s.slice(i + 1, close) } };
    return null;
  }
  if (c === '[') return linkAt(s, i);
  if (c === '<') {
    MENTION_Y.lastIndex = i;
    const m = MENTION_Y.exec(s);
    if (m) return { len: m[0].length, node: { type: 'mention', userId: m[1] } };
    return null;
  }
  if ((c === 'h' || c === 'H') && (i === 0 || !/[A-Za-z0-9]/.test(s[i - 1]))) {
    URL_Y.lastIndex = i;
    const m = URL_Y.exec(s);
    if (m) {
      const url = trimUrl(m[0]);
      if (url.length > url.indexOf('//') + 2) return { len: url.length, node: { type: 'link', href: url, text: url } };
    }
    return null;
  }
  return null;
}

/** [文字](https://...) を読む。href が http(s) でなければ null（素のテキストになる） */
function linkAt(s: string, i: number): Atom | null {
  const close = s.indexOf(']', i + 1);
  if (close === -1 || close === i + 1 || s[close + 1] !== '(') return null;
  const text = s.slice(i + 1, close);
  if (text.trim() === '' || text.includes('[')) return null;
  // 括弧の対応を見て、リンクの閉じ ) を探す（URL 内の (…) を許す）
  let depth = 0;
  let k = close + 2;
  for (; k < s.length; k++) {
    if (s[k] === '(') depth++;
    else if (s[k] === ')') {
      if (depth === 0) break;
      depth--;
    }
  }
  if (k >= s.length) return null;
  const href = s.slice(close + 2, k);
  if (!HTTP_HREF.test(href)) return null;
  return { len: k + 1 - i, node: { type: 'link', href, text } };
}

/** 閉じ記号として使えるか（直前が空白でない、単語の途中でない、など） */
function closeOk(s: string, k: number, delim: string): boolean {
  const before = s[k - 1];
  if (before === undefined || /\s/.test(before)) return false;
  const after = s[k + delim.length];
  // `_` と `__` は単語の途中（snake_case など）では閉じない
  if ((delim === '_' || delim === '__') && after !== undefined && UNDERSCORE_WORD.test(after)) return false;
  // `*` の閉じが `**` の一部なら飛ばす
  if (delim === '*' && (s[k + 1] === '*' || s[k - 1] === '*')) return false;
  return true;
}

/** 強調の閉じを探す。見つからなければ -1 */
function findClose(s: string, from: number, delim: string): number {
  let k = from;
  while (k < s.length) {
    const atom = atomAt(s, k);
    if (atom) {
      k += atom.len;
      continue;
    }
    if (k > from && s.startsWith(delim, k) && closeOk(s, k, delim)) return k;
    k++;
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
  outer: while (i < s.length) {
    const atom = atomAt(s, i);
    if (atom) {
      if (atom.node) {
        flush();
        out.push(atom.node);
      } else {
        buf += atom.text;
      }
      i += atom.len;
      continue;
    }

    if (depth < 8) {
      for (const [delim, kind] of DOUBLE) {
        if (!s.startsWith(delim, i)) continue;
        const after = s[i + delim.length];
        if (after === undefined || /\s/.test(after)) continue;
        if (delim === '__' && i > 0 && UNDERSCORE_WORD.test(s[i - 1])) continue;
        const j = findClose(s, i + delim.length, delim);
        if (j === -1) continue;
        flush();
        out.push({ type: kind, children: parseInline(s.slice(i + delim.length, j), depth + 1) });
        i = j + delim.length;
        continue outer;
      }

      const c = s[i];
      if (
        (c === '_' || (c === '*' && s[i + 1] !== '*')) &&
        s[i + 1] !== undefined &&
        !/\s/.test(s[i + 1]) &&
        (c !== '_' || i === 0 || !UNDERSCORE_WORD.test(s[i - 1]))
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

    buf += s[i];
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
