import type { User } from './protocol/User';

/** 入力欄では `@表示名` で見せ、送るときに `<@user_id>` に置き換える */
export function bodyToDraft(body: string, users: Record<string, User>, map: Map<string, string>): string {
  return body.replace(/<@([A-Za-z0-9_-]{1,64})>/g, (all, id: string) => {
    const u = users[id];
    if (!u) return all;
    map.set(u.display_name, id);
    return '@' + u.display_name;
  });
}

export function draftToBody(draft: string, map: Map<string, string>): string {
  if (map.size === 0) return draft;
  // 長い名前から置き換える（前方一致する別の名前を壊さないため）
  const names = [...map.keys()].filter((n) => n).sort((a, b) => b.length - a.length);
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp('@(' + escaped.join('|') + ')', 'g');
  return draft.replace(re, (_, name: string) => `<@${map.get(name)}>`);
}

/** キャレットの直前にある `@query` を探す */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|[\s(（])@([^\s@<>]{0,32})$/.exec(before);
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}

export function filterUsers(users: User[], query: string, limit = 8): User[] {
  const q = query.toLowerCase();
  return users
    .filter((u) => !q || u.display_name.toLowerCase().includes(q) || u.login_name.toLowerCase().includes(q))
    .sort((a, b) => {
      const ap = a.display_name.toLowerCase().startsWith(q) ? 0 : 1;
      const bp = b.display_name.toLowerCase().startsWith(q) ? 0 : 1;
      return ap - bp;
    })
    .slice(0, limit);
}
