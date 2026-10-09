import { describe, expect, it } from 'vitest';
import { bodyToDraft, draftToBody, filterUsers, mentionQuery } from './mentions';
import type { User } from './protocol/User';

const u = (id: string, name: string): User => ({ id, login_name: id + '@x', display_name: name, avatar_url: null, created_at: 0 });

describe('mentions', () => {
  it('roundtrip', () => {
    const users = { a: u('a', 'Alice'), b: u('b', 'Al') };
    const map = new Map<string, string>();
    const draft = bodyToDraft('hi <@a> and <@b>!', users, map);
    expect(draft).toBe('hi @Alice and @Al!');
    expect(draftToBody(draft, map)).toBe('hi <@a> and <@b>!');
  });

  it('names with regex chars', () => {
    const map = new Map([['a.b (x)', 'id1']]);
    expect(draftToBody('@a.b (x) yo', map)).toBe('<@id1> yo');
  });

  it('query detection', () => {
    expect(mentionQuery('hello @al', 9)).toEqual({ start: 6, query: 'al' });
    expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQuery('mail@example', 12)).toBeNull();
  });

  it('filter', () => {
    const list = [u('1', 'Bob'), u('2', 'alice'), u('3', 'Malia')];
    expect(filterUsers(list, 'al').map((x) => x.id)).toEqual(['2', '3']);
  });
});
