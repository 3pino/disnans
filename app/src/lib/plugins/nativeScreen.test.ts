import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  linux: true,
  android: false,
  tauri: true,
  invoke: vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => undefined),
  events: new Map<string, (event: { payload: unknown }) => void>(),
  offs: [] as ReturnType<typeof vi.fn>[],
  listen: vi.fn(),
}));
vi.mock('../platform', () => ({
  isTauri: () => fake.tauri,
  isAndroid: () => fake.android,
  isLinuxDesktop: () => fake.tauri && fake.linux && !fake.android,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: fake.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: fake.listen }));

import { pipApi, screenCaptureApi } from './nativeScreen';

beforeEach(() => {
  fake.linux = true;
  fake.android = false;
  fake.tauri = true;
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
  it('Linux のアプリで対応し、Linux の PiP やブラウザー版には対応を誤って広げない', () => {
    expect(screenCaptureApi.supported).toBe(true);
    expect(pipApi.supported).toBe(false);
    fake.tauri = false;
    expect(screenCaptureApi.supported).toBe(false);
    fake.tauri = true;
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
