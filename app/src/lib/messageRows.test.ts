import { describe, expect, it } from 'vitest';
import { GROUP_MS, isContinuation, type RowLike } from './messageRows';

const base: RowLike = { author_id: 'a', created_at: 1_000_000, thread: null };

describe('isContinuation', () => {
  it('同じ人が5分未満で続けたら連続', () => {
    expect(isContinuation(base, { ...base, created_at: base.created_at + 1000 }, false)).toBe(true);
  });

  it('前がなければ連続ではない', () => {
    expect(isContinuation(null, base, false)).toBe(false);
  });

  it('投稿者が違えば連続ではない', () => {
    expect(isContinuation(base, { ...base, author_id: 'b' }, false)).toBe(false);
  });

  it('5分以上あけば連続ではない（ちょうど5分も含めない）', () => {
    expect(isContinuation(base, { ...base, created_at: base.created_at + GROUP_MS - 1 }, false)).toBe(true);
    expect(isContinuation(base, { ...base, created_at: base.created_at + GROUP_MS }, false)).toBe(false);
  });

  it('日付が変わる発言は連続ではない', () => {
    expect(isContinuation(base, { ...base, created_at: base.created_at + 1000 }, true)).toBe(false);
  });

  it('スレッドの起点（前の発言が thread を持つ、または自分が thread を持つ）は連続ではない', () => {
    const root = { ...base, thread: { reply_count: 1 } };
    expect(isContinuation(root, { ...base, created_at: base.created_at + 1000 }, false)).toBe(false);
    expect(isContinuation(base, { ...base, created_at: base.created_at + 1000, thread: { reply_count: 0 } }, false)).toBe(false);
  });
});
