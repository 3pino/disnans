import { beforeEach, describe, expect, it } from 'vitest';
import { explorerBuffer } from './explorerBuffer.svelte';

beforeEach(() => explorerBuffer.clear());

describe('アプリ内の切り取り・コピーのバッファ', () => {
  it('切り取りは、貼り付けたものを外し、残りがなければ空に戻す', () => {
    explorerBuffer.set('move', [
      { path: 'a.txt', kind: 'file' },
      { path: 'b.txt', kind: 'file' },
    ]);
    expect(explorerBuffer.isCut('a.txt')).toBe(true);
    explorerBuffer.remove(['a.txt']);
    expect(explorerBuffer.items.map((i) => i.path)).toEqual(['b.txt']);
    explorerBuffer.remove(['b.txt']);
    expect(explorerBuffer.empty).toBe(true);
    expect(explorerBuffer.mode).toBeNull();
  });

  it('コピーは切り取りの印を付けない（貼り付けても外さない）', () => {
    explorerBuffer.set('copy', [{ path: 'a.txt', kind: 'file' }]);
    expect(explorerBuffer.isCut('a.txt')).toBe(false);
    expect(explorerBuffer.empty).toBe(false);
  });
});
