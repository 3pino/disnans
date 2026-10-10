import { describe, expect, it } from 'vitest';
import { authorOf, isOwnMessage } from './author';
import type { User } from './protocol/User';

const alice: User = { id: 'u1', login_name: 'a@x', display_name: 'Alice', avatar_url: '/a.webp', created_at: 0 };
const users = new Map([[alice.id, alice]]);

describe('authorOf', () => {
  it('人の発言は表示名とアバター', () => {
    expect(authorOf({ author_id: 'u1', bot: null }, users)).toEqual({ name: 'Alice', avatarUrl: '/a.webp', isBot: false });
  });
  it('いない人は不明なユーザー', () => {
    expect(authorOf({ author_id: 'zz', bot: null }, users)).toEqual({ name: '不明なユーザー', avatarUrl: null, isBot: false });
  });
  it('ボットはボットの名前とプラグインのアイコン', () => {
    const msg = { author_id: 'u1', bot: { plugin: 'dice', name: 'ダイス' } };
    expect(authorOf(msg, users, (id) => `/icon/${id}`)).toEqual({ name: 'ダイス', avatarUrl: '/icon/dice', isBot: true, botPlugin: 'dice' });
    expect(authorOf(msg, users).avatarUrl).toBeNull();
  });
  it('Record の usersById も使える', () => {
    expect(authorOf({ author_id: 'u1', bot: null }, { u1: alice }).name).toBe('Alice');
  });
});

describe('isOwnMessage', () => {
  it('自分の人としての発言だけ true', () => {
    expect(isOwnMessage({ author_id: 'u1', bot: null }, 'u1')).toBe(true);
    expect(isOwnMessage({ author_id: 'u2', bot: null }, 'u1')).toBe(false);
    expect(isOwnMessage({ author_id: 'u1', bot: { plugin: 'p', name: 'n' } }, 'u1')).toBe(false);
    expect(isOwnMessage({ author_id: 'u1', bot: null }, undefined)).toBe(false);
  });
});
