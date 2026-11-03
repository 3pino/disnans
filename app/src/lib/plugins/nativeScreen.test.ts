import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  linux: true,
  android: false,
  invoke: vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => undefined),
  events: new Map<string, (event: { payload: unknown }) => void>(),
  offs: [] as ReturnType<typeof vi.fn>[],
  listen: vi.fn(),
  pluginEvents: new Map<string, (payload: unknown) => void>(),
  addPluginListener: vi.fn(async (_plugin: string, event: string, cb: (payload: unknown) => void) => {
    fake.pluginEvents.set(event, cb);
    return { unregister: async () => {} };
  }),
}));
vi.mock('../platform', () => ({
  isAndroid: () => fake.android,
  // 方針（Rust の capabilities と同じ規則）: Android なら android、Linux なら linux（Tauri 版だけ。ブラウザー版は無い）
  capabilities: () => ({
    nativeScreen: fake.android ? 'android' : fake.linux ? 'linux' : null,
  }),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: fake.invoke, addPluginListener: fake.addPluginListener }));
vi.mock('@tauri-apps/api/event', () => ({ listen: fake.listen }));

import { pipApi, screenCaptureApi, validateCallRelay } from './nativeScreen';
import { PluginError } from './errors';

beforeEach(() => {
  fake.linux = true;
  fake.android = false;
  fake.events.clear();
  fake.offs = [];
  fake.invoke.mockReset().mockResolvedValue(undefined);
  fake.listen.mockReset().mockImplementation(async (name: string, cb: (event: { payload: unknown }) => void) => {
    fake.events.set(name, cb);
    const off = vi.fn(() => fake.events.delete(name));
    fake.offs.push(off);
    return off;
  });
});
afterEach(async () => {
  await screenCaptureApi.stop();
});

const options = { maxEdge: 1280, quality: 0.6, fps: 5 };
const frame = { data: '/9j/QUJDRA==', mime: 'image/jpeg', width: 1280, height: 720 };
const captureId = () => {
  const args = fake.invoke.mock.calls.filter(([command]) => command === 'linux_screen_start').at(-1)![1] as { options: { captureId: number } };
  return args.options.captureId;
};

describe('Linux のネイティブ画面取得', () => {
  it('Linux のアプリで対応し、Linux の PiP には対応を広げない', () => {
    expect(screenCaptureApi.supported).toBe(true);
    expect(pipApi.supported).toBe(false);
    fake.linux = false;
    expect(screenCaptureApi.supported).toBe(false);
  });

  it('イベントを購読してから取得し、最初のフレーム・設定変更・停止を処理する', async () => {
    const got = vi.fn();
    fake.invoke.mockImplementation(async (command) => {
      if (command === 'linux_screen_start') {
        expect(fake.events.size).toBe(2);
        fake.events.get('linux-screen-frame')!({ payload: { ...frame, captureId: captureId() } });
      }
    });
    await screenCaptureApi.start(options, got);
    expect(got).toHaveBeenCalledWith(frame);
    expect(fake.invoke).toHaveBeenCalledWith('linux_screen_start', { options: expect.objectContaining(options) });
    await screenCaptureApi.update({ quality: 0.4, scale: 0.75 });
    expect(fake.invoke).toHaveBeenCalledWith('linux_screen_update', { options: { quality: 0.4, scale: 0.75 } });
    const stale = fake.events.get('linux-screen-frame')!;
    await screenCaptureApi.stop();
    expect(fake.invoke).toHaveBeenCalledWith('linux_screen_stop', undefined);
    expect(fake.offs.every((off) => off.mock.calls.length === 1)).toBe(true);
    stale({ payload: { ...frame, captureId: captureId() } });
    expect(got).toHaveBeenCalledTimes(1);
  });

  it('OS 側の終了でコールバックを一度だけ呼び、購読を片付ける', async () => {
    const onEnd = vi.fn();
    await screenCaptureApi.start({ ...options, onEnd }, vi.fn());
    const end = fake.events.get('linux-screen-end')!;
    end({ payload: { captureId: captureId() } });
    end({ payload: { captureId: captureId() } });
    expect(onEnd).toHaveBeenCalledOnce();
    expect(fake.events.size).toBe(0);
    await screenCaptureApi.update({ quality: 0.4 });
    expect(fake.invoke.mock.calls.map(([command]) => command)).toEqual(['linux_screen_start']);
  });

  it('前の取得から遅れて届いたフレーム・終了を新しい取得へ混ぜない', async () => {
    await screenCaptureApi.start(options, vi.fn());
    const old = captureId();
    const got = vi.fn();
    const onEnd = vi.fn();
    await screenCaptureApi.start({ ...options, onEnd }, got);
    fake.events.get('linux-screen-frame')!({ payload: { ...frame, captureId: old } });
    fake.events.get('linux-screen-end')!({ payload: { captureId: old, reason: 'stopped' } });
    expect(got).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
    fake.events.get('linux-screen-frame')!({ payload: { ...frame, captureId: captureId() } });
    expect(got).toHaveBeenCalledWith(frame);
  });

  it('許可のキャンセルを AbortError にし、購読を残さない', async () => {
    fake.invoke.mockRejectedValue({ code: 'cancelled', message: '共有がキャンセルされました' });
    await expect(screenCaptureApi.start(options, vi.fn())).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.events.size).toBe(0);
    expect(fake.offs.every((off) => off.mock.calls.length === 1)).toBe(true);
  });

  it('片方の購読に失敗しても、成功した購読を片付けて取得を始めない', async () => {
    fake.listen.mockRejectedValueOnce(new Error('購読に失敗'));
    await expect(screenCaptureApi.start(options, vi.fn())).rejects.toThrow('購読に失敗');
    expect(fake.invoke).not.toHaveBeenCalled();
    expect(fake.events.size).toBe(0);
    expect(fake.offs[0]).toHaveBeenCalledOnce();
  });
});

describe('通話へのネイティブ送信（API v16）', () => {
  const relay = { frameEvent: 'screen.frame', stateEvent: 'screen.state', queryEvent: 'screen.query', state: { source: 'screen' } };
  const emitPlugin = (event: string, payload: unknown) => fake.pluginEvents.get(event)!(payload);
  /** Android（この版の APK）。本体の命令は start / stop / update だけ（確かめの命令は無い） */
  function android() {
    fake.android = true;
    fake.linux = false;
    fake.invoke.mockImplementation(async () => undefined);
  }
  const invokedCommands = () => fake.invoke.mock.calls.map(([command]) => command);
  const startArgs = () => fake.invoke.mock.calls.filter(([c]) => c === 'plugin:screen|start_capture').at(-1)![1] as Record<string, unknown>;
  const androidCaptureId = () => startArgs().captureId as number;

  it('validateCallRelay: 正しい形は通し、名前・状態の決まりに外れたものは invalid_argument', () => {
    expect(validateCallRelay(relay)).toEqual(relay);
    expect(validateCallRelay({ frameEvent: 'a', stateEvent: 'b' })).toEqual({ frameEvent: 'a', stateEvent: 'b' });
    const bad: unknown[] = [
      null,
      { stateEvent: 'b' },
      { frameEvent: '', stateEvent: 'b' },
      { frameEvent: 'x'.repeat(65), stateEvent: 'b' },
      { frameEvent: 'audio', stateEvent: 'b' },
      { frameEvent: 'a', stateEvent: 'a' },
      { frameEvent: 'a', stateEvent: 'b', queryEvent: 'a' },
      { frameEvent: 'a', stateEvent: 'b', state: 'x' },
      { frameEvent: 'a', stateEvent: 'b', state: { on: true } },
      { frameEvent: 'a', stateEvent: 'b', state: { nested: {} } },
      { frameEvent: 'a', stateEvent: 'b', state: { n: Number.NaN } },
      { frameEvent: 'a', stateEvent: 'b', state: { big: 'x'.repeat(300) } },
    ];
    for (const r of bad) {
      expect(() => validateCallRelay(r), JSON.stringify(r)).toThrow(PluginError);
      expect(() => validateCallRelay(r)).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
    }
  });

  it('supportsCallRelay は Android だけ true（確かめの命令は使わない）。Linux は false', async () => {
    fake.linux = true;
    fake.android = false;
    vi.resetModules();
    const linux = await import('./nativeScreen');
    expect(linux.screenCaptureApi.supportsCallRelay).toBe(false);
    expect(fake.invoke).not.toHaveBeenCalled();

    android();
    vi.resetModules();
    const fresh = await import('./nativeScreen');
    expect(fresh.screenCaptureApi.supportsCallRelay).toBe(true);
    expect(fake.invoke).not.toHaveBeenCalled();
  });

  it('Linux で通話への送信を頼むと、本体を呼ばずに unsupported（黙って別の経路にしない）', async () => {
    await expect(screenCaptureApi.start({ ...options, callRelay: relay }, vi.fn())).rejects.toMatchObject({ code: 'unsupported' });
    expect(fake.invoke).not.toHaveBeenCalled();
    expect(fake.listen).not.toHaveBeenCalled();
  });

  it('Android の通話への送信: 確かめの命令は使わず、撮り始める前に descriptor と captureId を渡す。通常の取得は descriptor を渡さない', async () => {
    android();
    await screenCaptureApi.start({ ...options, callRelay: relay }, vi.fn());
    expect(invokedCommands()).toEqual(['plugin:screen|start_capture']);
    expect(startArgs()).toMatchObject({ captureId: expect.any(Number), callRelay: relay, maxEdge: 1280 });
    await screenCaptureApi.stop();

    android();
    await screenCaptureApi.start(options, vi.fn());
    expect(startArgs()).not.toHaveProperty('callRelay');
    expect(invokedCommands()).not.toContain('plugin:screen|call_relay_supported');
    await screenCaptureApi.stop();
  });

  it('Android: 撮り始めた回（captureId）と違うフレーム・終了は捨てる。captureId の無いものも捨てる（厳密に一致したものだけ通す）', async () => {
    android();
    const got = vi.fn();
    const onEnd = vi.fn();
    await screenCaptureApi.start({ ...options, callRelay: relay, onEnd }, got);
    const id = androidCaptureId();
    emitPlugin('capture_frame', { ...frame, captureId: id + 1 });
    emitPlugin('capture_frame', frame);
    expect(got).not.toHaveBeenCalled();
    emitPlugin('capture_end', { reason: 'stopped', captureId: id + 1 });
    emitPlugin('capture_end', { reason: 'stopped' });
    expect(onEnd).not.toHaveBeenCalled();
    emitPlugin('capture_frame', { ...frame, captureId: id });
    expect(got).toHaveBeenCalledOnce();
    emitPlugin('capture_end', { reason: 'stopped', captureId: id });
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it('Android: 止めたら captureId つきで本体に止めさせる。update も同じ回に向ける', async () => {
    android();
    await screenCaptureApi.start({ ...options, callRelay: relay }, vi.fn());
    const id = androidCaptureId();
    await screenCaptureApi.update({ quality: 0.4 });
    expect(fake.invoke).toHaveBeenCalledWith('plugin:screen|update_capture', { quality: 0.4, captureId: id });
    await screenCaptureApi.stop();
    expect(fake.invoke).toHaveBeenLastCalledWith('plugin:screen|stop_capture', { captureId: id });
  });

  it('Android: 開始の応答が来る前に止めたら、撮り始めたものを、その回の captureId で止め直す（取り残さない）', async () => {
    android();
    let finishStart: () => void = () => {};
    const pending = new Promise<void>((r) => (finishStart = r));
    fake.invoke.mockImplementation(async (command: string) => {
      if (command === 'plugin:screen|start_capture') {
        await pending;
      }
      return undefined;
    });
    const started = screenCaptureApi.start({ ...options, callRelay: relay }, vi.fn());
    await vi.waitFor(() => expect(invokedCommands()).toContain('plugin:screen|start_capture'));
    const id = (fake.invoke.mock.calls.find(([c]) => c === 'plugin:screen|start_capture')![1] as { captureId: number }).captureId;
    await screenCaptureApi.stop();
    finishStart();
    await expect(started).rejects.toMatchObject({ name: 'AbortError' });
    const stops = () => fake.invoke.mock.calls.filter(([c]) => c === 'plugin:screen|stop_capture');
    // 止める命令は動的 import のあとに届くので、届くまで待つ
    await vi.waitFor(() => expect(stops().length).toBe(2));
    expect(stops().every(([, args]) => (args as { captureId: number }).captureId === id)).toBe(true);
    expect(invokedCommands().filter((c) => c === 'plugin:screen|call_relay_supported')).toEqual([]);
  });
});
