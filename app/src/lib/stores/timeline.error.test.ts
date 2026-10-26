import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Message } from '../protocol/Message';

// 最初の読み込みが失敗したときの状態。接続の失敗は、接続の案内に出せる（errorIsConnection）。
// 失敗したあとは自動で読み直さない（needsFirstLoad）。再試行・接続が戻ったときだけ読む
const h = vi.hoisted(() => ({
  next: null as null | (() => Promise<unknown>),
  calls: 0,
}));
vi.mock('../api', () => ({
  api: {
    messages: () => {
      h.calls++;
      return h.next!() as Promise<Message[]>;
    },
  },
}));

const { Timeline, needsFirstLoad } = await import('./timeline.svelte');
const { ConnectionError } = await import('../transport/http');
const { HttpError } = await import('../transport/http');

beforeEach(() => {
  h.calls = 0;
  h.next = null;
});

describe('最初の読み込みの失敗', () => {
  it('つながらない（timeout）なら、接続の失敗として記録し、読み込み中は止まる', async () => {
    h.next = () => Promise.reject(new ConnectionError('timeout', '応答がありません（15 秒）'));
    const t = new Timeline();
    await t.load();
    expect(t.loading).toBe(false);
    expect(t.loaded).toBe(false);
    expect(t.error).toBe('応答がありません（15 秒）');
    expect(t.errorIsConnection).toBe(true);
  });

  it('サーバーの HTTP エラーは、接続の失敗にしない（従来の「読み込めませんでした」）', async () => {
    h.next = () => Promise.reject(new HttpError(401, 'unauthorized', '認証できませんでした'));
    const t = new Timeline();
    await t.load();
    expect(t.errorIsConnection).toBe(false);
    expect(t.error).toBeTruthy();
  });

  it('失敗したあとは、自動で読み直さない（needsFirstLoad は false。繰り返し読まない）', async () => {
    h.next = () => Promise.reject(new ConnectionError('network', '届きません'));
    const t = new Timeline();
    await t.load();
    expect(needsFirstLoad(true, t)).toBe(false);
    expect(needsFirstLoad(true, { loaded: false, loading: false, error: null })).toBe(true);
    expect(needsFirstLoad(false, { loaded: false, loading: false, error: null })).toBe(false);
    expect(h.calls).toBe(1);
  });

  it('再試行（load）で復旧すると、エラーは消えて読み込み済みになる', async () => {
    h.next = () => Promise.reject(new ConnectionError('timeout', '応答がありません'));
    const t = new Timeline();
    await t.load();
    expect(t.errorIsConnection).toBe(true);

    h.next = () => Promise.resolve([] as Message[]);
    await t.load();
    expect(t.error).toBeNull();
    expect(t.errorIsConnection).toBe(false);
    expect(t.loaded).toBe(true);
    expect(h.calls).toBe(2);
  });
});
