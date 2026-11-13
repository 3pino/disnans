import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmitQueue } from './emitQueue';

afterEach(() => vi.useRealTimers());

describe('EmitQueue', () => {
  it('積んだものを順に渡し、渡したら空になる', () => {
    const q = new EmitQueue();
    q.push('a', 1); q.push('b', 2);
    const send = vi.fn();
    q.flush(send);
    expect(send.mock.calls).toEqual([['a', 1], ['b', 2]]);
    q.flush(send);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('上限（50 件）を超えたものは捨てる', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const q = new EmitQueue();
    for (let i = 0; i < 60; i++) q.push('x', i);
    const send = vi.fn();
    q.flush(send);
    expect(send).toHaveBeenCalledTimes(50);
  });

  it('5 秒たっても載らなければ捨てる。drop でも捨てる', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const q = new EmitQueue();
    q.push('a', 1);
    vi.advanceTimersByTime(5001);
    const send = vi.fn();
    q.flush(send);
    expect(send).not.toHaveBeenCalled();
    q.push('b', 2); q.drop(); q.flush(send);
    expect(send).not.toHaveBeenCalled();
  });
});
