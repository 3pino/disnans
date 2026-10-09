import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarkRead } from '../protocol/MarkRead';
import type { Message } from '../protocol/Message';
import type { ReadMarker } from '../protocol/ReadMarker';
import { MARK_DEBOUNCE_MS, MAIN_KEY, Unread, firstUnread, nextUnreadKey } from './unread.svelte';

const ME = 'me';
const BOB = 'bob';

function msg(id: string, author: string, threadId: string | null = null): Message {
  return {
    id,
    author_id: author,
    thread_id: threadId,
    body: '',
    attachments: [],
    reactions: [],
    created_at: 0,
    edited_at: null,
    thread: null,
    card: null,
  };
}

function marker(threadId: string | null, last: string, count: number): ReadMarker {
  return { thread_id: threadId, last_read_id: last, unread_count: count };
}

function setup(markers: ReadMarker[] = []) {
  const sent: MarkRead[] = [];
  const store = new Unread({
    send: async (b) => {
      sent.push(b);
    },
    fetch: async () => markers,
  });
  store.me = ME;
  return { store, sent };
}

describe('Unread', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('loads markers from the server', async () => {
    const { store } = setup([marker(null, '05', 2), marker('T1', '03', 0), marker('T2', '04', 3)]);
    await store.load();
    expect(store.loaded).toBe(true);
    expect(store.main).toBe(2);
    expect(store.count('T1')).toBe(0);
    expect(store.count('T2')).toBe(3);
    expect(store.threadTotal).toBe(3);
    expect(store.cursor('T1')).toBe('03');
    // 0 のものは持たない
    expect(MAIN_KEY in store.counts).toBe(true);
    expect('T1' in store.counts).toBe(false);
  });

  it('counts only newer messages from others', () => {
    const { store } = setup();
    store.applyAll([marker(null, '05', 0), marker('T1', '05', 0)]);
    store.onMessage(msg('06', BOB));
    store.onMessage(msg('07', ME));
    store.onMessage(msg('04', BOB)); // 既読の位置より古い
    store.onMessage(msg('08', BOB, 'T1'));
    expect(store.main).toBe(1);
    expect(store.count('T1')).toBe(1);
    // 知らないスレッド（読み込み後にできた）は全部未読
    store.onMessage(msg('09', BOB, 'T9'));
    expect(store.count('T9')).toBe(1);
  });

  it('decrements when an unread message is deleted', () => {
    const { store } = setup();
    store.applyAll([marker(null, '05', 2)]);
    store.onDeleted('03', null, BOB); // 既読
    expect(store.main).toBe(2);
    store.onDeleted('07', null, ME); // 自分の
    expect(store.main).toBe(2);
    store.onDeleted('06', null, undefined);
    store.onDeleted('07', null, BOB);
    expect(store.main).toBe(0);
    store.onDeleted('08', null, BOB);
    expect(store.main).toBe(0);
  });

  it('marks read locally at once and sends to the server debounced', async () => {
    const { store, sent } = setup();
    store.applyAll([marker(null, '05', 2), marker('T1', '05', 1)]);
    store.markRead(null, '06');
    store.markRead(null, '07');
    store.markRead('T1', '09');
    expect(store.main).toBe(0);
    expect(store.cursor(null)).toBe('07');
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(MARK_DEBOUNCE_MS);
    expect(sent).toEqual([
      { thread_id: null, message_id: '07' },
      { thread_id: 'T1', message_id: '09' },
    ]);
    // 戻らない（古い位置は送らない）
    store.markRead(null, '06');
    await vi.advanceTimersByTimeAsync(MARK_DEBOUNCE_MS);
    expect(sent).toHaveLength(2);
    expect(store.cursor(null)).toBe('07');
  });

  it('clears a stale count without sending when already read', async () => {
    const { store, sent } = setup();
    store.applyAll([marker(null, '05', 0)]);
    store.counts[MAIN_KEY] = 1;
    store.markRead(null, '05');
    expect(store.main).toBe(0);
    await vi.advanceTimersByTimeAsync(MARK_DEBOUNCE_MS);
    expect(sent).toEqual([]);
  });

  it('flush sends immediately', () => {
    const { store, sent } = setup();
    store.markRead(null, '01');
    store.flush();
    expect(sent).toEqual([{ thread_id: null, message_id: '01' }]);
  });

  it('applies remote markers only when they move forward', () => {
    const { store } = setup();
    store.applyAll([marker(null, '05', 3)]);
    store.applyRemote(marker(null, '04', 9));
    expect(store.main).toBe(3);
    store.applyRemote(marker(null, '07', 1));
    expect(store.main).toBe(1);
    expect(store.cursor(null)).toBe('07');
    // 新しいスレッドの既読も受け取る
    store.applyRemote(marker('T1', '08', 0));
    expect(store.cursor('T1')).toBe('08');
  });

  it('ignores remote markers behind a pending local mark', () => {
    const { store } = setup();
    store.applyAll([marker(null, '05', 3)]);
    store.markRead(null, '09');
    store.applyRemote(marker(null, '07', 2));
    expect(store.main).toBe(0);
    expect(store.cursor(null)).toBe('09');
  });

  it('keeps pending marks when reloading', () => {
    const { store } = setup();
    store.markRead(null, '09');
    store.applyAll([marker(null, '05', 3), marker('T1', '01', 2)]);
    expect(store.main).toBe(0);
    expect(store.cursor(null)).toBe('09');
    expect(store.count('T1')).toBe(2);
  });

  it('forgets removed threads', () => {
    const { store } = setup();
    store.applyAll([marker(null, '05', 0), marker('T1', '01', 2)]);
    store.removeScope('T1');
    expect(store.threadTotal).toBe(0);
    expect(store.cursor('T1')).toBeUndefined();
  });
});

describe('firstUnread', () => {
  const list = [msg('01', BOB), msg('02', ME), msg('03', ME), msg('04', BOB), msg('05', BOB)];

  it('finds the first newer message from others', () => {
    expect(firstUnread(list, '01', ME)?.id).toBe('04');
    expect(firstUnread(list, '04', ME)?.id).toBe('05');
    expect(firstUnread(list, '05', ME)).toBeNull();
    // 位置が分からなければ、他人の最初のメッセージ
    expect(firstUnread(list, undefined, ME)?.id).toBe('01');
  });
});

describe('nextUnreadKey', () => {
  const order = [MAIN_KEY, 'A', 'B', 'C'];

  it('walks forward and wraps around', () => {
    const counts = { A: 1, C: 2 };
    expect(nextUnreadKey(order, counts, MAIN_KEY)).toBe('A');
    expect(nextUnreadKey(order, counts, 'A')).toBe('C');
    expect(nextUnreadKey(order, counts, 'C')).toBe('A');
    expect(nextUnreadKey(order, { [MAIN_KEY]: 1 }, 'B')).toBe(MAIN_KEY);
  });

  it('walks backward', () => {
    const counts = { A: 1, C: 2 };
    expect(nextUnreadKey(order, counts, MAIN_KEY, -1)).toBe('C');
    expect(nextUnreadKey(order, counts, 'C', -1)).toBe('A');
    expect(nextUnreadKey(order, counts, 'A', -1)).toBe('C');
  });

  it('returns the current one when only it has unread, and null when nothing', () => {
    expect(nextUnreadKey(order, { B: 1 }, 'B')).toBe('B');
    expect(nextUnreadKey(order, {}, 'B')).toBeNull();
    expect(nextUnreadKey([], {}, MAIN_KEY)).toBeNull();
  });

  it('starts from the ends when the current one is unknown', () => {
    expect(nextUnreadKey(order, { A: 1, C: 1 }, 'gone')).toBe('A');
    expect(nextUnreadKey(order, { A: 1, C: 1 }, 'gone', -1)).toBe('C');
  });
});
