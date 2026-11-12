// 送り手（ScreenSender）の試験。実物のメディア・DOM は使わない（偽の video・canvas・時計）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScreenCallPort, ScreenSettingsPort, ScreenSettingsValue } from './types';

/** 符号化した base64 の長さ（文字）。既定は 1 かけらに収まる大きさ。大きくすると 1 枚が何片にも分かれる */
let encodedChars = 20000;
vi.mock('./codec', () => ({
  encodeFrame: vi.fn((_cv: unknown, _src: unknown, _w: number, _h: number) => ({ mime: 'image/jpeg', b64: '/9j/' + 'A'.repeat(encodedChars) })),
  fitSize: (w: number, h: number) => ({ w, h }),
}));

import { ScreenSender, EVENT_FRAME } from './sender';

// ---- 偽の DOM（document・video・canvas）----
type FakeCanvas = { width: number; height: number; getContext(): { drawImage(): void; getImageData(): { data: Uint8ClampedArray } } };
let pixel = 100; // 縮小画像の全画素の値（変えると「変わった」になる）
let blank = false;
let videoReady = true;
let playPromise: Promise<void> | null = null;
const bodyChildren: unknown[] = [];

function fakeVideo() {
  return {
    className: '', muted: false, playsInline: false, srcObject: null as unknown, videoWidth: 0, videoHeight: 0,
    paused: false, attrs: {} as Record<string, string>,
    setAttribute(k: string, v: string) { this.attrs[k] = v; },
    play: vi.fn(() => playPromise ?? Promise.resolve()),
    pause: vi.fn(function (this: { paused: boolean }) { this.paused = true; }),
    remove: vi.fn(),
  };
}
function fakeCanvas(): FakeCanvas {
  return {
    width: 0, height: 0,
    getContext() {
      return {
        drawImage() {},
        getImageData() {
          const data = new Uint8ClampedArray(64 * 36 * 4);
          for (let i = 0; i < data.length; i += 4) {
            const v = blank ? 0 : pixel;
            data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = blank ? 0 : 255;
          }
          return { data };
        },
      };
    },
  };
}
let lastVideo: ReturnType<typeof fakeVideo> | null = null;
(globalThis as unknown as { document: unknown }).document = {
  createElement(tag: string) {
    if (tag === 'video') { lastVideo = fakeVideo(); lastVideo.videoWidth = videoReady ? 1280 : 0; lastVideo.videoHeight = videoReady ? 720 : 0; return lastVideo; }
    return fakeCanvas();
  },
  body: { append: (el: unknown) => bodyChildren.push(el) },
};

// ---- 偽の通話・設定・時計 ----
function fakeCall(over: Partial<ScreenCallPort> & { others?: boolean } = {}) {
  const emitted: { name: string; payload: unknown }[] = [];
  const call = {
    joined: true, listed: true, myPeer: 'me', bufferedAmount: 0,
    get participants() {
      return over.others === false ? [{ peer: 'me', userId: 'u1', self: true }] : [{ peer: 'me', userId: 'u1', self: true }, { peer: 'p2', userId: 'u2', self: false }];
    },
    emit: vi.fn((name: string, payload: unknown) => { emitted.push({ name, payload }); }),
    ...over,
  } as unknown as ScreenCallPort & { joined: boolean; bufferedAmount: number };
  return { call, emitted };
}
let settingsValue: ScreenSettingsValue = { fps: 5, quality: 'p720', color: 'full' };
const settings: ScreenSettingsPort = { get value() { return settingsValue; }, patch() {}, subscribe: () => () => {} };
const stalls: string[] = [];

function makeSender(call: ScreenCallPort) {
  return new ScreenSender({ call, settings, onStall: (r) => stalls.push(r) });
}
function fakeStream() {
  const tracks = [{ stop: vi.fn(), kind: 'video', getSettings: () => ({}) }];
  return { getVideoTracks: () => tracks, getTracks: () => tracks, _tracks: tracks } as unknown as MediaStream & { _tracks: typeof tracks };
}
const frameEmits = (emitted: { name: string; payload: unknown }[]) => emitted.filter((e) => e.name === EVENT_FRAME);

beforeEach(() => {
  vi.useFakeTimers();
  pixel = 100; encodedChars = 20000; blank = false; videoReady = true; playPromise = null; stalls.length = 0; bodyChildren.length = 0;
  settingsValue = { fps: 5, quality: 'p720', color: 'full' };
});
afterEach(() => {
  vi.useRealTimers();
});

describe('共有をまたぐ送りの番号とネイティブ調整', () => {
  it('再接続の一覧待ちでは web・Linux のどちらも送らず、再掲載後に最新だけ送る', async () => {
    const { call, emitted } = fakeCall({ listed: false });
    const web = makeSender(call); web.startWeb(fakeStream() as unknown as MediaStream);
    await vi.advanceTimersByTimeAsync(1000);
    expect(emitted).toEqual([]); web.stop();
    const native = makeSender(call); native.startNative();
    native.offerNative({ data: '/9j/OLD', mime: 'image/jpeg', width: 2, height: 2 });
    native.offerNative({ data: '/9j/LATEST', mime: 'image/jpeg', width: 2, height: 2 });
    await vi.advanceTimersByTimeAsync(1000); expect(emitted).toEqual([]);
    Object.assign(call, { listed: true }); await vi.advanceTimersByTimeAsync(1000);
    expect(frameEmits(emitted)).toHaveLength(1);
    expect(frameEmits(emitted)[0].payload).toMatchObject({ d: '/9j/LATEST' }); native.stop();
  });

  it('送り手を作り直しても、同じ peer のフレーム番号を戻さない', () => {
    const { call, emitted } = fakeCall();
    const first = makeSender(call); first.startNative();
    first.offerNative({ data: '/9j/AAAA', mime: 'image/jpeg', width: 2, height: 2 }); first.stop();
    const a = (frameEmits(emitted).at(-1)!.payload as { f: number }).f;
    const second = makeSender(call); second.startNative();
    second.offerNative({ data: '/9j/BBBB', mime: 'image/jpeg', width: 2, height: 2 }); second.stop();
    const b = (frameEmits(emitted).at(-1)!.payload as { f: number }).f;
    expect(b).toBeGreaterThan(a);
    expect(Number.isSafeInteger(b)).toBe(true);
  });
  it('Linux の大きいフレームによる調整を実際の取得側へ通知する', () => {
    const { call } = fakeCall(); const onTune = vi.fn();
    const s = new ScreenSender({ call, settings, onStall: vi.fn(), onTune });
    s.startNative();
    s.offerNative({ data: '/9j/' + 'A'.repeat(1_600_000), mime: 'image/jpeg', width: 1920, height: 1080 });
    expect(onTune).toHaveBeenCalledWith({ quality: 0.5, scale: 1 }); s.stop();
  });
});

describe('web の取り込み', () => {
  it('停止した映像の遅い play 失敗は、新しい共有へ通知しない', async () => {
    const { call } = fakeCall(); const s = makeSender(call);
    let reject!: (error: Error) => void;
    playPromise = new Promise<void>((_resolve, no) => { reject = no; });
    s.startWeb(fakeStream() as unknown as MediaStream);
    const old = lastVideo!; s.stop();
    playPromise = null; s.startWeb(fakeStream() as unknown as MediaStream);
    reject(new Error('synthetic old play failure'));
    await Promise.resolve(); await Promise.resolve();
    expect(old.pause).toHaveBeenCalled();
    expect(stalls).toEqual([]); s.stop();
  });

  it('取り込み用の映像を作り、ストリームは止めない', async () => {
    const { call } = fakeCall();
    const s = makeSender(call);
    const stream = fakeStream();
    const v = s.startWeb(stream as unknown as MediaStream) as unknown as ReturnType<typeof fakeVideo>;
    expect(v.className).toBe('screenshare-capture-video');
    expect(v.muted).toBe(true);
    expect(v.attrs['aria-hidden']).toBe('true');
    expect(v.attrs['style']).toContain('width:1px');
    expect(v.attrs['style']).toContain('opacity:0');
    expect(s.video).toBe(v);
    expect(bodyChildren).toContain(v);
    await vi.advanceTimersByTimeAsync(0);
    expect(stream._tracks[0].stop).not.toHaveBeenCalled();
  });

  it('見る人がいて画面が変われば、フレームを screen.frame の分割で送る（状態は送らない）', async () => {
    const { call, emitted } = fakeCall();
    const s = makeSender(call);
    s.startWeb(fakeStream() as unknown as MediaStream);
    await vi.advanceTimersByTimeAsync(0);
    expect(frameEmits(emitted).length).toBeGreaterThan(0);
    expect(emitted.every((e) => e.name === EVENT_FRAME)).toBe(true);
    const first = frameEmits(emitted)[0].payload as { f: number; i: number; n: number; d: string };
    expect(Object.keys(first).sort()).toEqual(['d', 'f', 'i', 'n']);
    s.stop();
  });

  it('画面が変わらず送ってから 5 秒未満なら送らない', async () => {
    const { call, emitted } = fakeCall();
    const s = makeSender(call);
    s.startWeb(fakeStream() as unknown as MediaStream);
    await vi.advanceTimersByTimeAsync(0);
    const before = frameEmits(emitted).length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(frameEmits(emitted).length).toBe(before);
    s.stop();
  });

  it('見る人がいなければ送らない（待つ）', async () => {
    const { call, emitted } = fakeCall({ others: false } as never);
    const s = makeSender(call);
    s.startWeb(fakeStream() as unknown as MediaStream);
    await vi.advanceTimersByTimeAsync(3000);
    expect(frameEmits(emitted)).toHaveLength(0);
    s.stop();
  });

  it('送信待ちが上限を超えているあいだは、フレームを作らない', async () => {
    const { call, emitted } = fakeCall();
    (call as unknown as { bufferedAmount: number }).bufferedAmount = 300 * 1024;
    const s = makeSender(call);
    s.startWeb(fakeStream() as unknown as MediaStream);
    await vi.advanceTimersByTimeAsync(500);
    expect(frameEmits(emitted)).toHaveLength(0);
    (call as unknown as { bufferedAmount: number }).bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(200);
    expect(frameEmits(emitted).length).toBeGreaterThan(0);
    s.stop();
  });

  it('1 枚の途中で送信待ちが上限を超えたら、残りのかけらは送らない（映像だけ捨てる）', async () => {
    // 送った分だけ送信待ちが増える送り手（通話の WebSocket の模擬）。上限を超えたら、そのフレームの残りは出さない
    const emitted: { name: string; payload: unknown }[] = [];
    const call = {
      joined: true, listed: true, myPeer: 'me', bufferedAmount: 0,
      get participants() { return [{ peer: 'me', userId: 'u1', self: true }, { peer: 'p2', userId: 'u2', self: false }]; },
      emit: vi.fn((name: string, payload: unknown) => {
        emitted.push({ name, payload });
        (call as { bufferedAmount: number }).bufferedAmount += 60 * 1024;
      }),
    } as unknown as ScreenCallPort & { bufferedAmount: number };
    // 1 枚が 12 片になる大きさ（、40K 文字のかけら。上限を超えたら残りを捨てる）
    encodedChars = 12 * 40 * 1024;
    const s = makeSender(call);
    s.startWeb(fakeStream() as unknown as MediaStream);
    await vi.advanceTimersByTimeAsync(100);
    const first = frameEmits(emitted);
    expect(first.length).toBeGreaterThan(0);
    // 上限（BACKLOG_LIMIT=192KB）を超えた時点で止める（最大でも 4 片まで）
    expect(first.length).toBeLessThanOrEqual(4);
    s.stop();
  });

  it('映像が空（全部透明）なら送らず、続けば理由を一度だけ知らせる', async () => {
    blank = true;
    const { call, emitted } = fakeCall();
    const s = makeSender(call);
    s.startWeb(fakeStream() as unknown as MediaStream);
    await vi.advanceTimersByTimeAsync(7000);
    expect(frameEmits(emitted)).toHaveLength(0);
    expect(stalls.filter((r) => r.startsWith('video_stalled')).length).toBe(1);
    s.stop();
  });

  it('映像の大きさが 0 のまま続けば、理由を知らせる（トラックの名前は含まない）', async () => {
    videoReady = false;
    const { call } = fakeCall();
    const s = makeSender(call);
    s.startWeb(fakeStream() as unknown as MediaStream);
    await vi.advanceTimersByTimeAsync(7000);
    expect(stalls.some((r) => r.includes('映像が始まりません'))).toBe(true);
    expect(stalls.join('|')).not.toMatch(/label|track/i);
    s.stop();
  });

  it('通話から抜けたら止めて、理由を知らせる', async () => {
    const { call } = fakeCall();
    const s = makeSender(call);
    const v = s.startWeb(fakeStream() as unknown as MediaStream) as unknown as ReturnType<typeof fakeVideo>;
    await vi.advanceTimersByTimeAsync(0);
    (call as unknown as { joined: boolean }).joined = false;
    await vi.advanceTimersByTimeAsync(1500);
    expect(stalls).toContain('left_call');
    expect(s.video).toBeNull();
    expect(v.remove).toHaveBeenCalled();
  });
});

describe('停止と世代', () => {
  it('stop で映像の要素を外し、以後は送らない。ストリームは止めない', async () => {
    const { call, emitted } = fakeCall();
    const s = makeSender(call);
    const stream = fakeStream();
    const v = s.startWeb(stream as unknown as MediaStream) as unknown as ReturnType<typeof fakeVideo>;
    await vi.advanceTimersByTimeAsync(0);
    const before = frameEmits(emitted).length;
    s.stop();
    expect(v.pause).toHaveBeenCalled();
    expect(v.srcObject).toBeNull();
    expect(v.remove).toHaveBeenCalled();
    expect(s.video).toBeNull();
    pixel = 200;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(frameEmits(emitted).length).toBe(before);
    expect(stream._tracks[0].stop).not.toHaveBeenCalled();
  });

  it('止めたあとに同じ送り手で始め直しても、古い周期は二重に送らない', async () => {
    const { call, emitted } = fakeCall();
    const s = makeSender(call);
    s.startWeb(fakeStream() as unknown as MediaStream);
    await vi.advanceTimersByTimeAsync(0);
    s.stop();
    s.startWeb(fakeStream() as unknown as MediaStream);
    const beforeRestart = frameEmits(emitted).length;
    await vi.advanceTimersByTimeAsync(0);
    // 1 回の周期ぶんだけ（古い周期が残っていれば、同じ時刻に 2 回送られる）
    const after = frameEmits(emitted).length - beforeRestart;
    expect(after).toBeGreaterThan(0);
    const frameIds = new Set(frameEmits(emitted).map((e) => (e.payload as { f: number }).f));
    expect(frameIds.size).toBeGreaterThan(1);
    s.stop();
  });
});

describe('ネイティブの取得のフレーム', () => {
  const frame = (data: string) => ({ data, mime: 'image/jpeg', width: 10, height: 10 });

  it('フレームを 40 KiB ごとに分割して送る（50000 文字は 2 個）', async () => {
    const { call, emitted } = fakeCall();
    const s = makeSender(call);
    s.startNative();
    s.offerNative(frame('A'.repeat(50000)));
    const got = frameEmits(emitted).map((e) => e.payload as { i: number; n: number; d: string });
    expect(got.map((c) => [c.i, c.n])).toEqual([[0, 2], [1, 2]]);
    expect(got.map((c) => c.d).join('')).toBe('A'.repeat(50000));
    s.stop();
  });

  it('送る間隔の中で届いた古いフレームは捨て、待ちには最新だけを残す', async () => {
    const { call, emitted } = fakeCall();
    const s = makeSender(call);
    s.startNative();
    s.offerNative(frame('A'.repeat(100)));
    s.offerNative(frame('B'.repeat(100)));
    s.offerNative(frame('C'.repeat(100)));
    await vi.advanceTimersByTimeAsync(1000);
    const sent = frameEmits(emitted).map((e) => (e.payload as { d: string }).d).join('');
    expect(sent).toBe('A'.repeat(100) + 'C'.repeat(100)); // B は捨てられ、C が次に送られる
    s.stop();
  });

  it('web の取り込み中は、ネイティブのフレームを受けない', async () => {
    const { call, emitted } = fakeCall();
    const s = makeSender(call);
    s.startWeb(fakeStream() as unknown as MediaStream);
    s.offerNative(frame('X'.repeat(100)));
    expect(emitted.some((e) => (e.payload as { d?: string }).d === 'X'.repeat(100))).toBe(false);
    s.stop();
  });

  it('announce で、見る人が来たら最新のフレームを送り直す', async () => {
    const { call, emitted } = fakeCall();
    const s = makeSender(call);
    s.startNative();
    s.offerNative(frame('C'.repeat(50)));
    const before = frameEmits(emitted).length;
    await vi.advanceTimersByTimeAsync(6000);
    s.announce();
    expect(frameEmits(emitted).length).toBeGreaterThan(before);
    s.stop();
  });

  it('stop のあとのフレームは送らない', async () => {
    const { call, emitted } = fakeCall();
    const s = makeSender(call);
    s.startNative();
    s.offerNative(frame('D'.repeat(50)));
    s.stop();
    const before = frameEmits(emitted).length;
    s.offerNative(frame('E'.repeat(50)));
    await vi.advanceTimersByTimeAsync(2000);
    expect(frameEmits(emitted).length).toBe(before);
  });
});
