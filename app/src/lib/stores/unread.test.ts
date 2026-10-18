import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarkRead } from '../protocol/MarkRead';
import type { Message } from '../protocol/Message';
import type { ReadMarker } from '../protocol/ReadMarker';
import { MARK_DEBOUNCE_MS, Unread, firstUnread } from './unread.svelte';

const ME = 'me';
const BOB = 'bob';

function msg(id: string, author: string): Message {
  return {
    id,
    author_id: author,
    reply_to: null,
    reply_preview: null,
    body: '',
    attachments: [],
    reactions: [],
    created_at: 0,
    edited_at: null,
    card: null,
    bot: null,
  };
}

function marker(last: string, count: number): ReadMarker {
  return { last_read_id: last, unread_count: count };
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

  it('loads the marker from the server', async () => {
    const { store } = setup([marker('05', 2)]);
    await store.load();
    expect(store.loaded).toBe(true);
    expect(store.count).toBe(2);
    expect(store.cursor).toBe('05');
  });

  it('ignores thread_id on incoming markers (all are the main chat now)', () => {
    const { store } = setup();
    // 古い版のサーバーが送っても、thread_id は無視する
    store.applyAll([{ thread_id: 'old-thread', last_read_id: '05', unread_count: 4 } as unknown as ReadMarker]);
    expect(store.count).toBe(4);
    expect(store.cursor).toBe('05');
  });

  it('counts only newer messages from others', () => {
    const { store } = setup();
    store.applyAll([marker('05', 0)]);
    store.onMessage(msg('06', BOB));
    store.onMessage(msg('07', ME));
    store.onMessage(msg('04', BOB)); // 既読の位置より古い
    expect(store.count).toBe(1);
  });

  it('decrements when an unread message is deleted', () => {
    const { store } = setup();
    store.applyAll([marker('05', 2)]);
    store.onDeleted('03', BOB); // 既読
    expect(store.count).toBe(2);
    store.onDeleted('07', ME); // 自分の
    expect(store.count).toBe(2);
    store.onDeleted('06', undefined);
    store.onDeleted('07', BOB);
    expect(store.count).toBe(0);
    store.onDeleted('08', BOB);
    expect(store.count).toBe(0);
  });

  it('marks read locally at once and sends to the server debounced', async () => {
    const { store, sent } = setup();
    store.applyAll([marker('05', 2)]);
    store.markRead('06');
    store.markRead('07');
    expect(store.count).toBe(0);
    expect(store.cursor).toBe('07');
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(MARK_DEBOUNCE_MS);
    expect(sent).toEqual([{ message_id: '07' }]);
    // 戻らない（古い位置は送らない）
    store.markRead('06');
    await vi.advanceTimersByTimeAsync(MARK_DEBOUNCE_MS);
    expect(sent).toHaveLength(1);
    expect(store.cursor).toBe('07');
  });

  it('clears a stale count without sending when already read', async () => {
    const { store, sent } = setup();
    store.applyAll([marker('05', 0)]);
    store.count = 1;
    store.markRead('05');
    expect(store.count).toBe(0);
    await vi.advanceTimersByTimeAsync(MARK_DEBOUNCE_MS);
    expect(sent).toEqual([]);
  });

  it('flush sends immediately', () => {
    const { store, sent } = setup();
    store.markRead('01');
    store.flush();
    expect(sent).toEqual([{ message_id: '01' }]);
  });

  it('applies remote markers only when they move forward', () => {
    const { store } = setup();
    store.applyAll([marker('05', 3)]);
    store.applyRemote(marker('04', 9));
    expect(store.count).toBe(3);
    store.applyRemote(marker('07', 1));
    expect(store.count).toBe(1);
    expect(store.cursor).toBe('07');
  });

  it('ignores remote markers behind a pending local mark', () => {
    const { store } = setup();
    store.applyAll([marker('05', 3)]);
    store.markRead('09');
    store.applyRemote(marker('07', 2));
    expect(store.count).toBe(0);
    expect(store.cursor).toBe('09');
  });

  it('keeps pending marks when reloading', () => {
    const { store } = setup();
    store.markRead('09');
    store.applyAll([marker('05', 3)]);
    expect(store.count).toBe(0);
    expect(store.cursor).toBe('09');
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
