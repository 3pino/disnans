// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallStore } from './store.svelte';
import { CallSettings, createCallSource } from './settings.svelte';
import { FakeNativePort, deferred, snap } from './nativeFake';
import type { ScreenCaptureOptions, ScreenCapturePort, ScreenSettingsPort } from './screen/types';

const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const member = (peer: string, user_id: string) => ({ peer, user_id, status: { muted: false, deafened: false, device: 'monitor' } });
const all: CallStore[] = [];

// このファイルは通話と取得の寿命を確認する。符号化・送信は sender.test.ts で実物を確認する。
vi.mock('./screen/sender', () => ({ ScreenSender: class {
  video: HTMLVideoElement | null = null;
  startWeb() { return (this.video = document.createElement('video')); }
  offerNative() {} announce() {} stop() { this.video = null; }
} }));

class VideoTrack extends EventTarget {
  stop = vi.fn();
  getSettings() { return { facingMode: 'user' }; }
}
function videoStream() {
  const track = new VideoTrack();
  return { track, stream: { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream };
}

function make() {
  const port = new FakeNativePort();
  const captureGate = { current: null as ReturnType<typeof deferred<void>> | null };
  let options: ScreenCaptureOptions | null = null;
  const capture: ScreenCapturePort = {
    supported: true, supportsCallRelay: true,
    start: vi.fn(async (opts) => { options = opts; if (captureGate.current) await captureGate.current.promise; }),
    stop: vi.fn(async () => {}), update: vi.fn(async () => {}),
    snapshot: vi.fn(async () => ({ dataUrl: 'data:image/jpeg;base64,QUJD', width: 2, height: 2, source: 'app' as const })),
  };
  let value: ScreenSettingsPort['value'] = { fps: 5, quality: 'p720', color: 'full' };
  const listeners = new Set<() => void>();
  const settings: ScreenSettingsPort = {
    get value() { return value; },
    patch: (patch) => { value = { ...value, ...patch }; for (const cb of listeners) cb(); },
    subscribe: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
  };
  const server = { url: 'http://screen.test' };
  const toast = vi.fn();
  const store = new CallStore({
    native: port, serverUrl: () => server.url, send: vi.fn(), meId: () => 'me', nameOf: (id) => id,
    toast, confirm: async () => true, hold: vi.fn(),
    audio: { listOutputs: async () => [], listInputs: async () => [], setOutput: async () => true, attach: () => () => {} },
    settings: new CallSettings(createCallSource()), deviceKind: () => 'smartphone', openSettings: () => {}, now: () => performance.now(),
    screen: { capture, settings, toast },
  });
  all.push(store);
  return { store, port, capture, captureGate, options: () => options, server, toast };
}

async function joined(h: ReturnType<typeof make>) {
  await h.store.join();
  const session = h.port.starts.at(-1)!.session;
  h.port.pushState(snap({ session, generation: 2, seq: 1, phase: 'joined', wanted: true, listed: true, peer: 'self', serverUrl: h.server.url,
    members: [member('self', 'me'), member('remote-a', 'same-user'), member('remote-b', 'same-user')] }));
  await flush();
  return session;
}

afterEach(() => {
  for (const store of all.splice(0)) { store.screen?.dispose(); store.leave(); }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('標準の共有は CallStore が直接所有する', () => {
  it('プラグインを読み込まず参加・受信でき、参加だけでは画像やマイクを新たに取得しない', async () => {
    const h = make();
    const session = await joined(h);
    expect(h.store.screen).not.toBeNull();
    expect(h.capture.start).not.toHaveBeenCalled();
    expect(h.capture.snapshot).not.toHaveBeenCalled();
    h.port.pushRelay(session, 2, 2, 'remote-a', 'same-user', 'screen.state', { on: true, source: 'camera' });
    h.port.pushRelay(session, 2, 3, 'remote-b', 'same-user', 'screen.state', { on: true, source: 'screen' });
    h.port.pushRelay(session, 2, 4, 'remote-a', 'same-user', 'screen.frame', { f: 1, i: 0, n: 1, d: '/9j/QUJD' });
    await flush();
    expect(h.store.screen!.sharers).toHaveLength(2);
    expect(h.store.screen!.sharers.find((s) => s.peer === 'remote-a')).toMatchObject({ source: 'camera', dataUrl: 'data:image/jpeg;base64,/9j/QUJD' });
    expect(h.store.screen!.sharers.find((s) => s.peer === 'remote-b')).toMatchObject({ source: 'screen' });
  });

  it('Android は同じネイティブ送信を指定し、共有中に JS から状態やフレームを重ねて送らない', async () => {
    const h = make();
    await joined(h);
    await h.store.screen!.toggleScreen();
    expect(h.capture.start).toHaveBeenCalledTimes(1);
    expect(h.options()).toMatchObject({ callRelay: { frameEvent: 'screen.frame', stateEvent: 'screen.state', queryEvent: 'screen.query', state: { source: 'screen' } } });
    expect(h.store.screen!.sharing).toBe(true);
    const count = h.port.emits.length;
    h.store.screen!.onEvent('screen.query', { peer: 'remote-a', userId: 'same-user', payload: {} });
    h.store.screen!.stop();
    await flush();
    expect(h.port.emits.slice(count)).toEqual([]);
  });

  it('同じ通話の再接続や独立したチャット切断では取得を止めず、通話終了では止める', async () => {
    const h = make();
    const session = await joined(h);
    await h.store.screen!.toggleScreen();
    h.store.onLink(false);
    h.port.pushState(snap({ session, generation: 2, seq: 2, phase: 'recovering', wanted: true, peer: 'self', listed: false, linkUp: false }));
    await flush();
    expect(h.store.screen!.sharing).toBe(true);
    expect(h.capture.stop).not.toHaveBeenCalled();
    h.port.pushState(snap({ generation: 2, seq: 3, session: null, phase: 'idle' }));
    await flush();
    expect(h.store.screen!.sharing).toBe(false);
    expect(h.capture.stop).toHaveBeenCalled();
  });

  it('退出操作は通話の ACK より前に許可待ちを取り消し、遅い開始で復活しない', async () => {
    const h = make();
    await joined(h);
    h.captureGate.current = deferred<void>();
    const starting = h.store.screen!.toggleScreen();
    await flush();
    expect(h.store.screen!.starting).toBe(true);
    h.store.leave();
    expect(h.capture.stop).toHaveBeenCalledTimes(1);
    h.captureGate.current.resolve();
    await starting;
    expect(h.store.screen!.sharing).toBe(false);
    expect(h.store.screen!.starting).toBe(false);
  });

  it('接続先の変更も CallStore から共有を直接止める', async () => {
    const h = make();
    await joined(h);
    await h.store.screen!.toggleScreen();
    h.server.url = 'http://different.test';
    h.store.onServerChanged();
    expect(h.store.screen!.sharing).toBe(false);
    expect(h.capture.stop).toHaveBeenCalledTimes(1);
    await flush();
  });

  it('旧いネイティブ開始・終了が、新しい取得を止めない', async () => {
    const h = make(); await joined(h);
    const gate = deferred<void>(); h.captureGate.current = gate;
    const first = h.store.screen!.toggleScreen(); await flush();
    const oldEnd = h.options()!.onEnd!;
    h.store.screen!.stop(); h.captureGate.current = null;
    await h.store.screen!.toggleScreen();
    gate.resolve(); await first; oldEnd();
    expect(h.store.screen!.sharing).toBe(true);
    expect(h.capture.stop).toHaveBeenCalledTimes(1);
  });

  it('Windows の選択待ちに退出したら、遅い画面のハンドルを解放する', async () => {
    const h = make(); await joined(h);
    Object.assign(h.capture, { supported: false, supportsCallRelay: false });
    const gate = deferred<MediaStream>(); const fresh = videoStream();
    const getDisplayMedia = vi.fn(() => gate.promise);
    vi.stubGlobal('navigator', { userAgent: 'fake', mediaDevices: { getDisplayMedia } });
    const starting = h.store.screen!.toggleScreen(); await flush();
    h.store.leave(); gate.resolve(fresh.stream); await starting;
    expect(fresh.track.stop).toHaveBeenCalledTimes(1);
    expect(h.store.screen!.sharing).toBe(false);
    expect(getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: false }));
  });

  it('カメラ切替待ちの停止は、新旧両方の映像を解放し復活させない', async () => {
    const h = make(); await joined(h);
    const old = videoStream(); const fresh = videoStream(); const gate = deferred<MediaStream>();
    const getUserMedia = vi.fn().mockResolvedValueOnce(old.stream).mockImplementationOnce(() => gate.promise);
    vi.stubGlobal('navigator', { userAgent: 'fake', mediaDevices: { getUserMedia,
      getSupportedConstraints: () => ({ facingMode: true }), enumerateDevices: async () => [{ kind: 'videoinput' }, { kind: 'videoinput' }] } });
    await h.store.screen!.toggleCamera(); await flush();
    expect(h.store.screen!.canSwitchCamera).toBe(true);
    const switching = h.store.screen!.switchCamera(); await flush();
    h.store.screen!.stop(); gate.resolve(fresh.stream); await switching;
    expect(old.track.stop).toHaveBeenCalledTimes(1);
    expect(fresh.track.stop).toHaveBeenCalledTimes(1);
    expect(h.store.screen!.sharing).toBe(false);
    expect(getUserMedia.mock.calls.every(([args]) => args.audio === false)).toBe(true);
  });

  it('カメラ切替失敗では元の映像を保ち、古い track 終了は新しい共有へ作用しない', async () => {
    const h = make(); await joined(h);
    const camera = videoStream(); const display = videoStream();
    const getUserMedia = vi.fn().mockResolvedValueOnce(camera.stream).mockRejectedValueOnce(new Error('synthetic'));
    vi.stubGlobal('navigator', { userAgent: 'fake', mediaDevices: { getUserMedia,
      getDisplayMedia: vi.fn(async () => display.stream), getSupportedConstraints: () => ({ facingMode: true }),
      enumerateDevices: async () => [{ kind: 'videoinput' }, { kind: 'videoinput' }] } });
    await h.store.screen!.toggleCamera(); await flush();
    await h.store.screen!.switchCamera();
    expect(h.store.screen!.localStream).toBe(camera.stream);
    expect(camera.track.stop).not.toHaveBeenCalled();
    Object.assign(h.capture, { supported: false, supportsCallRelay: false });
    await h.store.screen!.toggleScreen(); camera.track.dispatchEvent(new Event('ended'));
    expect(h.store.screen!.sharing).toBe(true);
    expect(h.store.screen!.localStream).toBe(display.stream);
    expect(display.track.stop).not.toHaveBeenCalled();
  });
});
