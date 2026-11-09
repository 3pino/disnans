// 本文の段落の中で、画像の埋め込みが続くときの並べ方（横一列にまとめる）。Svelte の部品に依らない部分（テストで確かめる）。
// 木の形は変えない。段落の行（lines）を、表示の区切り（nodes・改行・横一列）に分けるだけ。

import type { Inline } from './markdown';

export type EmbedRowSegment =
  | { kind: 'nodes'; nodes: Inline[] }
  | { kind: 'break' }
  | { kind: 'row'; items: Inline[] };

type Tok = { kind: 'node'; node: Inline } | { kind: 'break' };
type Out = Tok | { kind: 'row'; items: Inline[] };

/** 空白だけの文字（続きを切らない） */
function isBlank(n: Inline): boolean {
  return n.type === 'text' && n.text.trim() === '';
}

/**
 * 段落の行を、表示の区切りに分ける。
 * - 画像の埋め込み（isImageEmbed が真の fileLink）が 2 つ以上、間に空白だけの文字か改行 1 つだけをはさんで続くと、横一列（row）にする
 * - 間に文字や別の要素（カードなど）があれば、そこで切れる。1 つだけの埋め込みは今までどおり（nodes の中に残す）
 * - 行の区切りの改行は、横一列の前後では出さない（横一列は行の代わりになる）
 */
export function embedRowSegments(lines: Inline[][], isImageEmbed: (n: Inline) => boolean): EmbedRowSegment[] {
  const toks: Tok[] = [];
  lines.forEach((line, j) => {
    if (j > 0) toks.push({ kind: 'break' });
    for (const node of line) toks.push({ kind: 'node', node });
  });

  const isEmbed = (t: Tok | undefined): t is { kind: 'node'; node: Inline } => !!t && t.kind === 'node' && isImageEmbed(t.node);
  const isGap = (t: Tok): boolean => t.kind === 'break' || isBlank(t.node);

  const out: Out[] = [];
  let afterRow = false;
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    // 横一列の直後の空白・改行は捨てる（横一列が行を変えている）
    if (afterRow && isGap(t)) {
      i++;
      continue;
    }
    afterRow = false;
    if (!isEmbed(t)) {
      out.push(t);
      i++;
      continue;
    }
    // 画像の埋め込みの続きを数える（間は空白 1 つか改行 1 つだけ）
    const items: Inline[] = [t.node];
    let last = i;
    for (;;) {
      let q = last + 1;
      let breaks = 0;
      while (q < toks.length && isGap(toks[q])) {
        if (toks[q].kind === 'break') breaks++;
        q++;
      }
      if (breaks > 1 || !isEmbed(toks[q])) break;
      items.push((toks[q] as { kind: 'node'; node: Inline }).node);
      last = q;
    }
    if (items.length < 2) {
      out.push(t);
      i++;
      continue;
    }
    // 横一列の前の空白・改行は捨てる
    while (out.length > 0) {
      const prev = out[out.length - 1];
      if (prev.kind === 'break' || (prev.kind === 'node' && isBlank(prev.node))) out.pop();
      else break;
    }
    out.push({ kind: 'row', items });
    afterRow = true;
    i = last + 1;
  }

  const segs: EmbedRowSegment[] = [];
  let nodes: Inline[] = [];
  const flush = () => {
    if (nodes.length > 0) segs.push({ kind: 'nodes', nodes });
    nodes = [];
  };
  for (const o of out) {
    if (o.kind === 'row') {
      flush();
      segs.push({ kind: 'row', items: o.items });
    } else if (o.kind === 'break') {
      flush();
      segs.push({ kind: 'break' });
    } else {
      nodes.push(o.node);
    }
  }
  flush();
  return segs;
}
