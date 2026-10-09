import type { User } from '../protocol/User';
import { filterUsers, mentionQuery } from '../mentions';
import type { SuggestProvider } from './types';

/** `@` でメンバーを出す。選んだら `@表示名 ` を入れ、onpick で対応表に足してもらう */
export function mentionProvider(users: () => User[], onpick: (u: User) => void): SuggestProvider {
  return {
    label: 'メンション',
    match(text, caret) {
      const q = mentionQuery(text, caret);
      return q && { ...q, end: caret };
    },
    items(_text, range) {
      return filterUsers(users(), range.query).map((u) => ({
        key: u.id,
        title: u.display_name,
        detail: u.login_name,
        user: u,
        insert: '@' + u.display_name + ' ',
        picked: () => onpick(u),
      }));
    },
  };
}
