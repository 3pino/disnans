import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../protocol/Message';
import { SEARCH_DEBOUNCE_MS, SEARCH_PAGE } from '../search';

const searchMessages = vi.fn();
vi.mock('../api', () => ({ api: { searchMessages: (o: unknown) => searchMessages(o) } }));

const { messageSearch } = await import('./search.svelte');

const msg = (id: string) => ({ id }) as Message;

beforeEach(() => {
  vi.useFakeTimers();
  searchMessages.mockReset();
  messageSearch.reset();
});
afterEach(() => vi.useRealTimers());

describe('messageSearch', () => {
  it('入力が止まってから検索し、結果は古い順に並ぶ', async () => {
    searchMessages.mockResolvedValue([msg('c'), msg('b'), msg('a')]);
    messageSearch.setQuery('あ');
    messageSearch.setQuery('あい');
    expect(searchMessages).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    expect(searchMessages).toHaveBeenCalledTimes(1);
    expect(searchMessages).toHaveBeenCalledWith({ q: 'あい', before: null, limit: SEARCH_PAGE });
    expect(messageSearch.hits.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(messageSearch.loading).toBe(false);
  });

  it('続きは一番古い結果の ID から取り、先頭側に足す', async () => {
    const first = Array.from({ length: SEARCH_PAGE }, (_, i) => msg(`m${100 - i}`));
    searchMessages.mockResolvedValueOnce(first);
    messageSearch.setQuery('x');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    expect(messageSearch.hasMore).toBe(true);
    searchMessages.mockResolvedValueOnce([msg('m70')]);
    await messageSearch.loadOlder();
    expect(searchMessages).toHaveBeenLastCalledWith({ q: 'x', before: `m${100 - SEARCH_PAGE + 1}`, limit: SEARCH_PAGE });
    expect(messageSearch.hits[0].id).toBe('m70');
    expect(messageSearch.hasMore).toBe(false);
  });

  it('失敗したら error に入る。語を空にすると消える', async () => {
    searchMessages.mockRejectedValue(new Error('boom'));
    messageSearch.setQuery('x');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    expect(messageSearch.error).toBe('boom');
    messageSearch.setQuery(' ');
    expect(messageSearch.error).toBeNull();
    expect(messageSearch.hits).toEqual([]);
  });
});
