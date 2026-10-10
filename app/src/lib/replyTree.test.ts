import { describe, expect, it } from 'vitest';
import type { Message } from './protocol/Message';
import { replyTree } from './replyTree';

function msg(id: string, replyTo: string | null, t: number): Message {
  return { id, reply_to: replyTo, created_at: t } as unknown as Message;
}

describe('replyTree', () => {
  it('起点から深さ優先で、兄弟は古い順に並べる', () => {
    const list = [msg('a', null, 1), msg('b', 'a', 2), msg('c', 'a', 3), msg('d', 'b', 4), msg('e', null, 5), msg('f', 'd', 6)];
    expect(replyTree(list, 'a').map((x) => [x.message.id, x.depth])).toEqual([
      ['a', 0],
      ['b', 1],
      ['d', 2],
      ['f', 3],
      ['c', 1],
    ]);
  });

  it('返信がなければ起点だけ、起点がなければ空', () => {
    const list = [msg('a', null, 1), msg('b', 'a', 2)];
    expect(replyTree(list, 'b').map((x) => x.message.id)).toEqual(['b']);
    expect(replyTree(list, 'zzz')).toEqual([]);
  });

  it('途中の返信が途切れていても（返信先が一覧にない）無視する', () => {
    const list = [msg('a', null, 1), msg('x', 'gone', 2)];
    expect(replyTree(list, 'a').map((x) => x.message.id)).toEqual(['a']);
  });
});
