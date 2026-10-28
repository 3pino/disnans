// 本文の表示に使う構文木の型と、木を読む・プレーンに作る部品。
// 木の本体（Markdown の解析）は Rust の core（crates/client-core/src/view/markdown.rs）だけが持つ。
// HTML の文字列は作らない（描画は Svelte 側でテキストノードとして行うので、生 HTML は入り込まない）。

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'bold'; children: Inline[] }
  | { type: 'italic'; children: Inline[] }
  | { type: 'underline'; children: Inline[] }
  | { type: 'strike'; children: Inline[] }
  | { type: 'highlight'; children: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; text: string }
  /** 共有フォルダのファイル（`[別名](パス)`・`[[パス|別名]]`）。embed は先頭に `!` が付いたもの。alias は省略されたら null */
  | { type: 'fileLink'; path: string; alias: string | null; embed: boolean }
  | { type: 'mention'; userId: string };

/** リストの1項目。1行目以降の段落行は lines に、入れ子のブロック（リスト・引用など）は children に入る */
export type ListItem = { lines: Inline[][]; children: Block[] };

export type Block =
  | { type: 'paragraph'; lines: Inline[][] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'quote'; children: Block[] }
  | { type: 'list'; ordered: boolean; start: number; items: ListItem[] };

/** `<@id>` をメンションとして読む（プレーンの木だけで使う。名前の差し込みは描画側） */
const MENTION_RE = /<@([A-Za-z0-9_-]{1,64})>/g;

/** 1 行をプレーンの部品にする。`<@id>` だけはメンションにする（送信中の本文の表示用） */
function plainLine(line: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of line.matchAll(MENTION_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ type: 'text', text: line.slice(last, at) });
    out.push({ type: 'mention', userId: m[1] });
    last = at + m[0].length;
  }
  if (last < line.length) out.push({ type: 'text', text: line.slice(last) });
  return out;
}

/**
 * 木が無いときの表示（送信中の本文・Rust の木が無いとき・Rust の解析の失敗）。書式は解釈せず、改行と `<@id>` だけを保つ。
 * 空の本文は木が空（何も出さない）。
 */
export function plainTree(body: string): Block[] {
  if (body === '') return [];
  return [{ type: 'paragraph', lines: body.split(/\r\n?|\n/).map(plainLine) }];
}

/**
 * 表示に使う構文木。Tauri の Rust 経路は、本文の木を `markdown`（Rust の core が作った木）として付けて送る。
 * 無いとき（送信中の仮表示・Rust の木が無いとき・Rust の解析の失敗）は、プレーンの木にする。
 */
export function treeOf(body: string, markdown?: unknown): Block[] {
  return Array.isArray(markdown) ? (markdown as Block[]) : plainTree(body);
}

/** メッセージの本文の木（`markdown` があれば使う） */
export function treeOfMessage(message: { body: string; markdown?: unknown }): Block[] {
  return treeOf(message.body, message.markdown);
}

/** メッセージに本文の木を付ける（描画の `markdown`）。undefined で外すと、描画は本文からプレーンに作る */
export function setTree(message: object, tree: Block[] | undefined): void {
  (message as { markdown?: Block[] }).markdown = tree;
}

/** 通知などのプレーンテキスト用: メンションを @名前 に置き換える */
export function mentionsToText(body: string, nameOf: (id: string) => string): string {
  return body.replace(MENTION_RE, (_, id: string) => '@' + nameOf(id));
}

function inlineMentions(nodes: Inline[], out: string[]): void {
  for (const n of nodes) {
    if (n.type === 'mention') out.push(n.userId);
    else if ('children' in n) inlineMentions(n.children, out);
  }
}

/** 木に含まれるメンションの ID（出現順） */
export function mentionIds(blocks: Block[]): string[] {
  const out: string[] = [];
  const walk = (list: Block[]) => {
    for (const b of list) {
      if (b.type === 'paragraph') b.lines.forEach((line) => inlineMentions(line, out));
      else if (b.type === 'quote') walk(b.children);
      else if (b.type === 'list') {
        for (const item of b.items) {
          item.lines.forEach((line) => inlineMentions(line, out));
          walk(item.children);
        }
      }
    }
  };
  walk(blocks);
  return out;
}
