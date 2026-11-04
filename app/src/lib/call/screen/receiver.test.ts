import { describe, expect, it, vi } from 'vitest';
import { ScreenReceiver, SCREEN_FRAME, SCREEN_STATE } from './receiver.svelte';
import type { ScreenCallPort } from './types';

function make() {
  let time = 0;
  const call: ScreenCallPort = {
    joined: true, listed: true, myPeer: 'self', bufferedAmount: 0,
    participants: [{ peer: 'a', userId: 'same', self: false }, { peer: 'b', userId: 'same', self: false }], emit: vi.fn(),
  };
  const receiver = new ScreenReceiver(call, () => time);
  const send = (peer: string, name: string, payload: unknown, userId = 'same') => receiver.event(name, { peer, userId, payload });
  return { call, receiver, send, time: (n: number) => { time = n; } };
}

describe('通話の標準の共有受信', () => {
  it('peer ごとに同一ユーザーの複数デバイスを区別し、未知の送り手を受け付けない', () => {
    const h = make();
    h.send('unknown', SCREEN_STATE, { on: true });
    h.send('a', SCREEN_STATE, { on: true }, 'wrong');
    expect(h.receiver.sharers).toEqual([]);
    h.send('a', SCREEN_STATE, { on: true, source: 'camera' });
    h.send('b', SCREEN_STATE, { on: true });
    expect(h.receiver.sharers.map((s) => [s.peer, s.source])).toEqual([['a', 'camera'], ['b', 'screen']]);
  });
  it('旧クライアントと同じ画像片を順不同で組み立て、重複・古い完了を表示しない', () => {
    const h = make();
    h.send('a', SCREEN_FRAME, { f: 1, i: 1, n: 2, d: 'QUJD' });
    h.send('a', SCREEN_FRAME, { f: 1, i: 0, n: 2, d: '/9j/' });
    expect(h.receiver.sharers[0].dataUrl).toBe('data:image/jpeg;base64,/9j/QUJD');
    h.send('a', SCREEN_FRAME, { f: 1, i: 0, n: 1, d: '/9j/OLD' });
    expect(h.receiver.sharers[0].dataUrl).toBe('data:image/jpeg;base64,/9j/QUJD');
  });
  it('取得ソースの変更では古い組み立てを破棄する', () => {
    const h = make();
    h.send('a', SCREEN_STATE, { on: true, source: 'camera' });
    h.send('a', SCREEN_FRAME, { f: 100, i: 0, n: 1, d: '/9j/CAMERA' });
    h.send('a', SCREEN_STATE, { on: true, source: 'screen' });
    expect(h.receiver.sharers[0].dataUrl).toBeNull();
    h.send('a', SCREEN_FRAME, { f: 2, i: 0, n: 1, d: '/9j/SCREEN' });
    expect(h.receiver.sharers[0].dataUrl).toBe('data:image/jpeg;base64,/9j/SCREEN');
  });
  it('生存通知を更新し、終了・退出・期限切れでは組み立ても破棄する', () => {
    const h = make();
    h.send('a', SCREEN_STATE, { on: true });
    h.time(9000); h.send('a', SCREEN_STATE, { on: true });
    h.time(10001); h.receiver.expire();
    expect(h.receiver.sharers).toHaveLength(1);
    h.time(19001); h.receiver.expire();
    expect(h.receiver.sharers).toEqual([]);
    h.send('a', SCREEN_STATE, { on: true });
    h.send('a', SCREEN_STATE, { on: false });
    expect(h.receiver.sharers).toEqual([]);
    h.send('a', SCREEN_STATE, { on: true });
    Object.assign(h.call, { participants: [] }); h.receiver.sync();
    expect(h.receiver.sharers).toEqual([]);
  });
  it('退出後に同じ peer が別ユーザーへ再利用されても、古い映像や途中の画像を引き継がない', () => {
    const h = make();
    h.send('a', SCREEN_STATE, { on: true });
    h.send('a', SCREEN_FRAME, { f: 100, i: 0, n: 2, d: '/9j/' });
    Object.assign(h.call, { participants: [{ peer: 'a', userId: 'new-user', self: false }] });
    h.receiver.sync(); expect(h.receiver.sharers).toEqual([]);
    h.send('a', SCREEN_FRAME, { f: 1, i: 0, n: 1, d: '/9j/NEW' }, 'new-user');
    expect(h.receiver.sharers[0]).toMatchObject({ userId: 'new-user', dataUrl: 'data:image/jpeg;base64,/9j/NEW' });
  });

  it('不正な状態や画像形式は表示しない', () => {
    const h = make();
    h.send('a', SCREEN_STATE, { on: 'true' });
    expect(h.receiver.sharers).toEqual([]);
    h.send('a', SCREEN_FRAME, { f: 1, i: 0, n: 1, d: '<script>bad</script>' });
    expect(h.receiver.sharers[0].dataUrl).toBeNull();
    Object.assign(h.call, { joined: false }); h.receiver.sync();
    expect(h.receiver.sharers).toEqual([]);
  });
});
