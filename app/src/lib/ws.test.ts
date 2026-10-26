import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Socket, type SocketStatus } from './ws';

// 接続の打ち切り: つながらない（応答が無い）ままの WebSocket は、上限の時間で閉じて再試行する。
// 永久に「接続中」のまま待たない。つながったら打ち切らない。

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static made: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeWebSocket.made.push(this);
  }
  send(): void {}
  close(): void {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
  }
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
}

beforeEach(() => {
  FakeWebSocket.made = [];
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function start(statuses: SocketStatus[]): Socket {
  const s = new Socket({ url: () => 'ws://srv.test/ws', onEvent: () => {}, onStatus: (st) => statuses.push(st) });
  s.start();
  return s;
}

describe('接続の上限時間', () => {
  it('15 秒つながらなければ閉じて、closed を知らせ、再試行する', async () => {
    const statuses: SocketStatus[] = [];
    const s = start(statuses);
    expect(FakeWebSocket.made).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(14_900);
    expect(FakeWebSocket.made[0].closed).toBe(false);
    expect(statuses).toEqual(['connecting']);

    await vi.advanceTimersByTimeAsync(200);
    expect(FakeWebSocket.made[0].closed).toBe(true);
    expect(statuses).toEqual(['connecting', 'closed']);

    // 再試行の間隔（最大 1 秒強）のあとに、新しい接続を作る
    await vi.advanceTimersByTimeAsync(2_000);
    expect(FakeWebSocket.made).toHaveLength(2);
    s.stop();
  });

  it('つながったら打ち切らない（開いたあと、上限の時間が過ぎても閉じない）', async () => {
    const statuses: SocketStatus[] = [];
    const s = start(statuses);
    FakeWebSocket.made[0].open();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeWebSocket.made[0].closed).toBe(false);
    expect(FakeWebSocket.made).toHaveLength(1);
    expect(statuses).toEqual(['connecting', 'open']);
    s.stop();
  });

  it('止めたあとは、打ち切りも再試行もしない', async () => {
    const statuses: SocketStatus[] = [];
    const s = start(statuses);
    s.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.made).toHaveLength(1);
    expect(statuses).toEqual(['connecting']);
  });
});
