// @vitest-environment jsdom
// 自分の共有を全画面で見る（LOCAL_VIEW）: 開ける条件・切り替え・共有が止まったときの扱い
import { describe, expect, it, vi } from 'vitest';
import { ScreenShareStore } from './store.svelte';
import { LOCAL_VIEW, type ScreenCallPort } from './types';

function make() {
  const call: ScreenCallPort = { joined: true, listed: true, myPeer: 'me', bufferedAmount: 0, participants: [{ peer: 'me', userId: 'u-me', self: true }, { peer: 'o', userId: 'u-o', self: false }], emit: vi.fn() };
  const store = new ScreenShareStore({
    call,
    capture: { supported: false, start: vi.fn(), stop: vi.fn(async () => {}), update: vi.fn(), snapshot: vi.fn() },
    settings: { value: { fps: 5, quality: 'p720', color: 'full' }, patch: vi.fn(), subscribe: () => () => {} },
    toast: vi.fn(),
  });
  return store;
}
const remote = (s: ScreenShareStore) => {
  s.onEvent('screen.state', { peer: 'o', userId: 'u-o', payload: { on: true } });
  s.onEvent('screen.frame', { peer: 'o', userId: 'u-o', payload: { f: 1, i: 0, n: 1, d: '/9j/QUJD' } });
};

describe('自分の共有を全画面で見る', () => {
  it('共有していないときは開けない（選択も変わらない）', () => {
    const s = make();
    s.openViewer(LOCAL_VIEW);
    expect(s.viewerOpen).toBe(false);
    expect(s.selectedPeer).toBeNull();
    s.dispose();
  });
  it('共有中は開け、相手の映像と切り替えられる', () => {
    const s = make();
    remote(s);
    s.sharing = true;
    s.openViewer(LOCAL_VIEW);
    expect(s.viewerOpen).toBe(true);
    expect(s.selectedPeer).toBe(LOCAL_VIEW);
    s.selectPeer('o');
    expect(s.selectedPeer).toBe('o');
    s.selectPeer(LOCAL_VIEW);
    expect(s.selectedPeer).toBe(LOCAL_VIEW);
    s.dispose();
  });
  it('自分の映像を見ている間に共有が止まったら、閉じる（相手の映像へ勝手に切り替えない）', () => {
    const s = make();
    remote(s);
    s.sharing = true;
    s.openViewer(LOCAL_VIEW);
    s.stop();
    expect(s.viewerOpen).toBe(false);
    s.dispose();
  });
  it('相手の映像を見ている間に自分が共有を止めても、閉じない', () => {
    const s = make();
    remote(s);
    s.sharing = true;
    s.openViewer('o');
    s.stop();
    expect(s.viewerOpen).toBe(true);
    expect(s.selectedPeer).toBe('o');
    s.dispose();
  });
});
