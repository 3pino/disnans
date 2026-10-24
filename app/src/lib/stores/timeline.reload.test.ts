import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Message } from '../protocol/Message';

// 添付の改名・削除は本文の表示（名前）を変える。読み込み済みの範囲を読み直して、古い履歴まで反映する
type Opts = { before?: string | null; limit?: number };
const h = vi.hoisted(() => ({ all: [] as unknown[], calls: [] as unknown[] }));
vi.mock('../api', () => ({
  api: {
    messages: async (opts: { before?: string | null; limit?: number }) => {
      h.calls.push(opts);
      return serveHistory(h.all as Message[], opts);
    },
  },
}));

const { Timeline } = await import('./timeline.svelte');

/** id が m001… の順。body は今の名前（版の印つき） */
const msg = (n: number, body = `見て attachments/old${n}.png`): Message =>
  ({ id: `m${String(n).padStart(3, '0')}`, body, attachments: [], author_id: 'u', created_at: 0, edited_at: null }) as unknown as Message;

/** サーバーの履歴（古い順）。limit 件ずつ before より古いものを返す（Rust の messages::page と同じ） */
function serveHistory(all: Message[], opts: Opts): Message[] {
  const limit = opts.limit ?? 50;
  const eligible = all.filter((m) => !opts.before || m.id < opts.before);
  return eligible.slice(-limit);
}
/** この後の API の応答の履歴をセットする */
const setServer = (all: Message[]) => {
  h.all = all;
};

beforeEach(() => {
  h.all = [];
  h.calls = [];
});

describe('Timeline.reloadLoaded（読み込み済みの範囲を読み直す）', () => {
  it('表示している分の本文を、今の名前にする（古い履歴も含む）', async () => {
    const t = new Timeline();
    const all = [msg(1), msg(2), msg(3)];
    setServer(all);
    await t.load();
    expect(t.messages.map((m) => m.id)).toEqual(['m001', 'm002', 'm003']);
    // 名前が変わった（サーバーの本文が変わった）
    const renamed = [msg(1, '見て attachments/new1.png'), msg(2), msg(3, '見て attachments/new3.png')];
    setServer(renamed);
    await t.reloadLoaded();
    expect(t.messages.map((m) => m.body)).toEqual(['見て attachments/new1.png', '見て attachments/old2.png', '見て attachments/new3.png']);
  });

  it('範囲が 1 ページより長くても、読み込み済みの一番古いところまで読み直す（それより新しいものは取り直す）', async () => {
    const t = new Timeline();
    const all = Array.from({ length: 120 }, (_, i) => msg(i + 1));
    setServer(all);
    // 最新のページから、古い方へ 70 件（m051〜m120）を読み込んだ状態を作る
    await t.load();
    await t.loadOlder();
    await t.loadOlder();
    const firstBefore = t.messages[0].id;
    expect(t.messages.length).toBeGreaterThan(50);
    h.calls = [];
    setServer(all);
    await t.reloadLoaded();
    expect(h.calls.length).toBeGreaterThanOrEqual(2);
    expect(t.messages[0].id).toBe(firstBefore);
    expect(t.messages.at(-1)?.id).toBe('m120');
  });

  it('削除された分は、読み直しのあとで消える', async () => {
    const t = new Timeline();
    const all = [msg(1), msg(2), msg(3)];
    setServer(all);
    await t.load();
    setServer([msg(1), msg(3)]);
    await t.reloadLoaded();
    expect(t.messages.map((m) => m.id)).toEqual(['m001', 'm003']);
  });

  it('まだ読み込んでいないときは、何もしない（読み込みのみ）', async () => {
    const t = new Timeline();
    setServer([msg(1)]);
    await t.reloadLoaded();
    expect(t.loaded).toBe(true);
    expect(t.messages).toHaveLength(1);
  });
});
