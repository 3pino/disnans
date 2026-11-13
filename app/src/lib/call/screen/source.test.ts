// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeFramesScreenSource, NativeRelayScreenSource, selectScreenSource, WebScreenSource } from './source';
import type { ScreenCapturePort, ScreenSettingsValue } from './types';

const settings: ScreenSettingsValue = { fps: 5, quality: 'p720', color: 'full' };
const hooks = () => ({ onFrame: vi.fn(), onEnd: vi.fn() });
function capture(over: Partial<ScreenCapturePort> = {}): ScreenCapturePort {
  return { supported: true, supportsCallRelay: false, start: vi.fn(async () => {}), stop: vi.fn(async () => {}), update: vi.fn(async () => {}), snapshot: vi.fn(), ...over };
}
afterEach(() => vi.unstubAllGlobals());

describe('selectScreenSource', () => {
  it('取得の対応と中継の対応から、アダプターを 1 つ選ぶ', () => {
    expect(selectScreenSource(capture({ supported: false }))).toBeInstanceOf(WebScreenSource);
    expect(selectScreenSource(capture())).toBeInstanceOf(NativeFramesScreenSource);
    expect(selectScreenSource(capture({ supportsCallRelay: true }))).toBeInstanceOf(NativeRelayScreenSource);
  });
});

describe('WebScreenSource', () => {
  it('画面は getDisplayMedia、カメラは getUserMedia があるときだけ始められる', () => {
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: vi.fn() } });
    const web = new WebScreenSource();
    expect(web.canStart('screen')).toBe(true);
    expect(web.canStart('camera')).toBe(false);
    vi.stubGlobal('navigator', { mediaDevices: {} });
    expect(web.canStart('screen')).toBe(false);
  });

  it('取得した stream を返し、discard で track を止める。送信は JS（relay なし）', async () => {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    const getDisplayMedia = vi.fn(async () => stream);
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia } });
    const web = new WebScreenSource();
    const got = await web.start('screen', settings, hooks());
    expect(web.relay).toBe(false);
    expect(got.stream).toBe(stream);
    expect(getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: false }));
    got.discard();
    expect(track.stop).toHaveBeenCalledOnce();
    await expect(web.stop()).resolves.toBeUndefined();
  });

  it('失敗の見せ方: 画面のキャンセルは黙る。カメラは理由を出す', () => {
    const web = new WebScreenSource();
    const abort = Object.assign(new Error('x'), { name: 'AbortError' });
    expect(web.failure('screen', abort)).toMatchObject({ silent: true });
    expect(web.failure('camera', abort).silent).toBe(false);
    expect(web.failure('camera', Object.assign(new Error('x'), { name: 'NotFoundError' })).message).toBe('カメラが見つかりません');
    expect(web.failure('screen', new Error('x'))).toEqual({ silent: false, message: '画面を取得できませんでした' });
  });
});

describe('ネイティブのアダプター', () => {
  it('Linux: 中継なし。フレームを onFrame へ流し、調整と停止を橋へ渡す', async () => {
    const port = capture();
    const src = new NativeFramesScreenSource(port);
    const h = hooks();
    const got = await src.start('screen', settings, h);
    const opts = vi.mocked(port.start).mock.calls[0][0];
    expect(src.relay).toBe(false);
    expect(opts).not.toHaveProperty('callRelay');
    expect(opts).toMatchObject({ fps: 5, format: 'jpeg', color: 'full' });
    expect(got.stream).toBeNull();
    src.tune({ quality: 0.4 });
    expect(port.update).toHaveBeenCalledWith({ quality: 0.4 });
    await src.stop();
    expect(port.stop).toHaveBeenCalledOnce();
    opts.onEnd?.();
    expect(h.onEnd).toHaveBeenCalledOnce();
  });

  it('Android: callRelay を渡し、調整は橋へ渡さない（ネイティブが持つ）', async () => {
    const port = capture({ supportsCallRelay: true });
    const src = new NativeRelayScreenSource(port);
    await src.start('screen', settings, hooks());
    expect(src.relay).toBe(true);
    expect(vi.mocked(port.start).mock.calls[0][0].callRelay).toMatchObject({ frameEvent: 'screen.frame', stateEvent: 'screen.state', queryEvent: 'screen.query', state: { source: 'screen' } });
    src.tune({ quality: 0.4 });
    expect(port.update).not.toHaveBeenCalled();
  });

  it('ネイティブはカメラを扱わない。画面のキャンセルは黙る', () => {
    const src = new NativeFramesScreenSource(capture());
    expect(src.canStart('camera')).toBe(false);
    expect(src.canStart('screen')).toBe(true);
    expect(src.failure('screen', Object.assign(new Error('x'), { name: 'AbortError' })).silent).toBe(true);
  });
});
