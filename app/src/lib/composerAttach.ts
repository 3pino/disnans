// 入力欄の添付: アップロードした添付を、本文の `![[名前]]` として入れる・外す決まり。
// 名前はアップロードの応答（Attachment.file_name）のもの（同じ名前があれば name (2).ext になっている）。

/** 添付の埋め込み（送信する本文に入る書き方。サーバーが ID に置き換えて保存する） */
export function embedFor(name: string): string {
  return `![[${name}]]`;
}

/**
 * キャレットの位置に文を入れる（キャレットが範囲の外なら末尾）。前が空白でなければ空白を 1 つ足す。
 * 返り値の caret は、入れた文の直後
 */
export function insertAt(text: string, caret: number, add: string): { text: string; caret: number } {
  const pos = Math.min(Math.max(caret, 0), text.length);
  const before = text.slice(0, pos);
  const after = text.slice(pos);
  const sep = before !== '' && !/\s$/.test(before) ? ' ' : '';
  return { text: before + sep + add + after, caret: before.length + sep.length + add.length };
}

/** 本文の中の最初の一致を、置き換える。見つからなければ null（本文は変えない） */
export function replaceFirst(text: string, from: string, to: string): { text: string; caret: number } | null {
  const i = text.indexOf(from);
  if (i < 0) return null;
  return { text: text.slice(0, i) + to + text.slice(i + from.length), caret: i + to.length };
}

/**
 * 添付の名前が使えないときの理由（使えるなら null）。アップロードの前に確かめ、送らない。
 * 本文の書き方（`[名前](…)` `[[名前|別名]]`）と衝突する `[ ] |` は、サーバーも断る（invalid_name）。名前は書き換えない。
 */
export function attachmentNameProblem(name: string): string | null {
  return /[[\]|]/.test(name) ? '添付の名前には [ ] | は使えません。ファイル名を変えてから添付してください' : null;
}
