import type { Message } from './protocol/Message';

/** ツリーの1行。depth は起点が 0、その返信が 1、返信の返信が 2 … */
export type TreeEntry = { message: Message; depth: number };

/**
 * rootId のメッセージを起点にした返信のツリーを、上から順に並べて返す（深さ優先、兄弟は古い順）。
 * messages は同じ場所（メインチャットか、同じスレッド）のメッセージ。起点が見つからなければ空。
 * 返信は起点より新しいので、起点が読み込まれていれば返信もすべて読み込まれている
 */
export function replyTree(messages: readonly Message[], rootId: string): TreeEntry[] {
  const root = messages.find((m) => m.id === rootId);
  if (!root) return [];
  const children = new Map<string, Message[]>();
  for (const m of messages) {
    if (m.reply_to === null) continue;
    const list = children.get(m.reply_to);
    if (list) list.push(m);
    else children.set(m.reply_to, [m]);
  }
  const out: TreeEntry[] = [];
  const seen = new Set<string>();
  const walk = (m: Message, depth: number) => {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    out.push({ message: m, depth });
    const list = children.get(m.id);
    if (!list) return;
    for (const c of [...list].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1))) walk(c, depth + 1);
  };
  walk(root, 0);
  return out;
}
