// @vitest-environment jsdom
// examples/screenshare をそのまま読み込んで、純粋な関数（分割・組み立て・調整）とプラグインの動きを確かめる
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginBase, PluginRuntime } from './runtime';
import { createUi } from './ui';
import { setLucideForTest } from '../icons.svelte';
import { API_VERSION, type HostServices, type PluginClass } from './types';
import { VersionConflictError } from './sessions';

type Mod = typeof import('../../../../examples/screenshare/main.js');
const load = () => import('../../../../examples/screenshare/main.js') as Promise<Mod & { default: PluginClass }>;

// main.js は読み込み時に disnans.Plugin と ui を覚える。call はプラグインの onload で読むので、テストごとに差し替える
(globalThis as unknown as { disnans: Partial<Disnans.Host> }).disnans = {
  apiVersion: API_VERSION,
  Plugin: PluginBase,
  ui: createUi({ toast: () => {}, confirm: async () => true }),
  VersionConflictError,
};

// ---- 純粋な関数 ----

describe('フレームの分割と組み立て', () => {
  it('分割して順不同に渡しても、元の文字列に戻る', async () => {
    const { splitFrame, FrameAssembler } = await load();
    const b64 = 'ABCDEFGHIJ'.repeat(25);
    const chunks = splitFrame(7, b64, 100);
    expect(chunks).toHaveLength(3);
    expect(chunks.every((c) => c.d.length <= 100 && c.f === 7 && c.n === 3)).toBe(true);
    const a = new FrameAssembler();
    expect(a.push(chunks[2])).toBeNull();
    expect(a.push(chunks[0])).toBeNull();
    expect(a.push(chunks[0])).toBeNull(); // 重複は無視
    expect(a.push(chunks[1])).toBe(b64);
  });

  it('既定の分割は 1 回の payload を 64 KB に収める', async () => {
    const { splitFrame, CHUNK_CHARS } = await load();
    const chunks = splitFrame(1, 'x'.repeat(CHUNK_CHARS * 2 + 5));
    expect(chunks).toHaveLength(3);
    for (const c of chunks) expect(JSON.stringify(c).length).toBeLessThan(64 * 1024);
  });

  it('欠けたフレームは、新しいフレームが来たら捨てる', async () => {
    const { splitFrame, FrameAssembler } = await load();
    const a = new FrameAssembler();
    const old = splitFrame(1, 'a'.repeat(250), 100);
    a.push(old[0]);
    a.push(old[1]); // 2 番目が欠けたまま
    const next = splitFrame(2, 'b'.repeat(150), 100);
    expect(a.push(next[0])).toBeNull();
    expect(a.push(old[2])).toBeNull(); // 古いかけらは無視
    expect(a.push(next[1])).toBe('b'.repeat(150));
    // 完成済みの番号のかけらは無視する
    expect(a.push(next[0])).toBeNull();
  });

  it('parseChunk は不正な形を弾く', async () => {
    const { parseChunk } = await load();
    expect(parseChunk({ f: 1, i: 0, n: 1, d: 'AA' })).toEqual({ f: 1, i: 0, n: 1, d: 'AA' });
    expect(parseChunk(null)).toBeNull();
    expect(parseChunk({ f: 1, i: 1, n: 1, d: 'AA' })).toBeNull();
    expect(parseChunk({ f: 1, i: 0, n: 1000, d: 'AA' })).toBeNull();
    expect(parseChunk({ f: 1.5, i: 0, n: 1, d: 'AA' })).toBeNull();
    expect(parseChunk({ f: 1, i: 0, n: 1, d: 5 })).toBeNull();
  });
});

describe('間隔・画質の調整', () => {
  it('fitSize は長辺を収め、拡大しない', async () => {
    const { fitSize } = await load();
    expect(fitSize(2560, 1440, 1280)).toEqual({ w: 1280, h: 720 });
    expect(fitSize(800, 600, 1280)).toEqual({ w: 800, h: 600 });
    expect(fitSize(2560, 1440, 1280, 0.5)).toEqual({ w: 640, h: 360 });
  });

  it('nextInterval は fps の上限と予算の長いほうを選び、上限を超えない', async () => {
    const { nextInterval, MAX_DELAY_MS } = await load();
    // 3 fps・予算 100 で、軽い（10）フレームは fps が決める
    expect(nextInterval({ fps: 3, weight: 10, budgetKBps: 100 })).toBeCloseTo(333.3, 0);
    // 重さ 100 のフレームは毎秒 100 の予算では 1 秒空ける
    expect(nextInterval({ fps: 3, weight: 100, budgetKBps: 100 })).toBe(1000);
    expect(nextInterval({ fps: 3, weight: 100000, budgetKBps: 100 })).toBe(MAX_DELAY_MS);
  });

  it('frameWeight は分割の回数と KB の和（サーバーの重さと同じ）', async () => {
    const { frameWeight } = await load();
    expect(frameWeight(2048, 2)).toBe(4);
  });

  it('tuneQuality は大きければ quality、次に scale を下げ、小さければ戻す', async () => {
    const { tuneQuality, QUALITY_PRESETS } = await load();
    const p = QUALITY_PRESETS.standard; // 予算 100 KB/s → 上限 61440 文字
    let t = { quality: 0.6, scale: 1 };
    t = tuneQuality(t, 100000, p);
    expect(t).toEqual({ quality: 0.5, scale: 1 });
    for (let i = 0; i < 5; i++) t = tuneQuality(t, 100000, p);
    expect(t.quality).toBe(0.35);
    expect(t.scale).toBeLessThan(1);
    for (let i = 0; i < 20; i++) t = tuneQuality(t, 100000, p);
    expect(t.scale).toBe(0.4); // 下限
    // 小さいフレームが続けば戻る（scale が先、その次に quality。もとの quality まで）
    for (let i = 0; i < 40; i++) t = tuneQuality(t, 1000, p);
    expect(t).toEqual({ quality: 0.6, scale: 1 });
    // 中くらいなら動かさない
    expect(tuneQuality(t, 50000, p)).toEqual(t);
  });

  it('frameDiff / shouldSend: 変化が無ければ送らず、しばらくたつか強制なら送る', async () => {
    const { frameDiff, shouldSend, KEEPALIVE_FRAME_MS } = await load();
    const a = new Uint8ClampedArray(16);
    const b = new Uint8ClampedArray(16);
    expect(frameDiff(a, b)).toBe(0);
    expect(frameDiff(null, b)).toBe(Infinity);
    b[0] = 255; // 12 色のうち 1 つが 255 差
    expect(frameDiff(a, b)).toBeCloseTo(255 / 12);
    b[3] = 200; // 透明度は見ない
    expect(frameDiff(a, b)).toBeCloseTo(255 / 12);
    expect(shouldSend({ diff: 0, sinceSentMs: 100, force: false })).toBe(false);
    expect(shouldSend({ diff: 10, sinceSentMs: 100, force: false })).toBe(true);
    expect(shouldSend({ diff: 0, sinceSentMs: KEEPALIVE_FRAME_MS, force: false })).toBe(true);
    expect(shouldSend({ diff: 0, sinceSentMs: 100, force: true })).toBe(true);
  });

  it('hasAudience / canShareScreen / parseSettings', async () => {
    const { hasAudience, canShareScreen, parseSettings } = await load();
    expect(hasAudience([{ self: true }])).toBe(false);
    expect(hasAudience([{ self: true }, { self: false }])).toBe(true);
    expect(canShareScreen(undefined)).toBe(false);
    expect(canShareScreen({})).toBe(false);
    expect(canShareScreen({ mediaDevices: {} })).toBe(false);
    expect(canShareScreen({ mediaDevices: { getDisplayMedia: () => {} } })).toBe(true);
    expect(parseSettings(null)).toEqual({ fps: 3, quality: 'standard' });
    expect(parseSettings({ fps: 5, quality: 'high' })).toEqual({ fps: 5, quality: 'high' });
    expect(parseSettings({ fps: 99, quality: 'toString' })).toEqual({ fps: 3, quality: 'standard' });
  });
});

// ---- プラグインの動き ----

type Handler = (e: { peer: string; user: Disnans.User; payload: unknown }) => void;
const users: Record<string, Disnans.User> = {
  a: { id: 'ua', login_name: 'a', display_name: 'アリス', avatar_url: null },
  b: { id: 'ub', login_name: 'b', display_name: 'ボブ', avatar_url: null },
};

function makeCall() {
  const handlers = new Map<string, Handler>();
  let change: () => void = () => {};
  let buttonOpts: Disnans.CallButtonOptions | null = null;
  const call = {
    joined: true,
    participants: [
      { peer: 'me', self: true },
      { peer: 'pa', self: false },
    ] as { peer: string; self: boolean }[],
    emit: vi.fn(),
    onEvent: (name: string, cb: Handler) => {
      handlers.set(name, cb);
      return () => handlers.delete(name);
    },
    onChange: (cb: () => void) => {
      change = cb;
      return () => {};
    },
    addButton: vi.fn((o: Disnans.CallButtonOptions) => {
      buttonOpts = { ...o };
      return {
        update: (p: Partial<Disnans.CallButtonOptions>) => Object.assign(buttonOpts!, p),
        remove: vi.fn(),
      };
    }),
    join: async () => {},
    leave: () => {},
  };
  return {
    call,
    button: () => buttonOpts,
    fire: (name: string, peer: string, userKey: 'a' | 'b', payload: unknown) => handlers.get(name)!({ peer, user: users[userKey], payload }),
    changed: () => change(),
  };
}

const g = globalThis as unknown as { disnans: Partial<Disnans.Host> };
const nav = navigator as unknown as { mediaDevices?: unknown };

function fakeStream() {
  const listeners: Record<string, () => void> = {};
  const track = { stop: vi.fn(), addEventListener: (ev: string, cb: () => void) => (listeners[ev] = cb) };
  return { stream: { getTracks: () => [track], getVideoTracks: () => [track] }, track, end: () => listeners.ended() };
}

async function setup(opts: { display: boolean }) {
  const c = makeCall();
  (g.disnans as { call: unknown }).call = c.call;
  const fs = fakeStream();
  const getDisplayMedia = vi.fn(async () => fs.stream);
  Object.defineProperty(nav, 'mediaDevices', { configurable: true, value: opts.display ? { getDisplayMedia } : undefined });
  const status: HTMLElement[] = [];
  const toast = vi.fn();
  const services = {
    app: { me: { id: 'u1' }, users: [], user: () => undefined, nameOf: () => '', isMobile: false, theme: 'light' },
    api: {},
    send: () => {},
    closePanel: () => {},
    openPanel: () => {},
    registerSlashCommand: () => () => {},
    registerComposerAction: () => () => {},
    registerCommand: () => () => {},
    toast,
    storage: { get: () => null, set: () => {} },
    pluginIcon: () => 'monitor-up',
    registerIcon: () => () => {},
    registerStatusItem: (_id: string, el: HTMLElement) => {
      status.push(el);
      document.body.append(el);
      return () => el.remove();
    },
    holdBackground: async () => Object.assign(() => {}, { update: () => {} }),
    changed: () => {},
  } as unknown as HostServices;
  const r = new PluginRuntime(
    { id: 'screenshare', name: '画面共有', version: '0.1.0', description: '', author: '', minApiVersion: 8 },
    services,
  );
  const mod = await load();
  await r.start(mod.default);
  return { ...c, r, fs, getDisplayMedia, status: () => status[0], toast };
}

const emitted = (c: ReturnType<typeof makeCall>['call'], name: string) =>
  c.emit.mock.calls.filter((a) => a[0] === name).map((a) => a[1] as Record<string, unknown>);

beforeEach(() => {
  vi.useFakeTimers();
  setLucideForTest({} as never);
  const ctx = { drawImage: () => {}, getImageData: () => ({ data: new Uint8ClampedArray(32 * 18 * 4) }) };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,QUJDRA==');
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 1920 });
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 1080 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setLucideForTest(null);
  document.body.replaceChildren();
  Reflect.deleteProperty(nav, 'mediaDevices');
});

describe('examples/screenshare', () => {
  it('getDisplayMedia が無い環境では共有ボタンを出さず、見ることはできる', async () => {
    const s = await setup({ display: false });
    expect(s.call.addButton).not.toHaveBeenCalled();
    s.fire('screen.state', 'pa', 'a', { on: true });
    s.fire('screen.frame', 'pa', 'a', { f: 0, i: 0, n: 1, d: 'QUJDRA==' });
    const btn = s.status().querySelector('button')!;
    expect(btn.textContent).toContain('アリス');
    btn.click();
    const img = document.querySelector<HTMLImageElement>('.screenshare-overlay img')!;
    expect(img.getAttribute('src')).toBe('data:image/jpeg;base64,QUJDRA==');
    s.r.stop();
  });

  it('共有を始めるとフレームを送り、同じボタンで止まる', async () => {
    const s = await setup({ display: true });
    expect(s.button()!.active).toBeFalsy();
    s.button()!.onClick();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.getDisplayMedia).toHaveBeenCalledOnce();
    expect(emitted(s.call, 'screen.state')[0]).toEqual({ on: true });
    expect(s.button()!.active).toBe(true);
    const frames = emitted(s.call, 'screen.frame');
    expect(frames).toEqual([{ f: 0, i: 0, n: 1, d: 'QUJDRA==' }]);

    // 画面が変わらないので、しばらくは送らない
    await vi.advanceTimersByTimeAsync(2000);
    expect(emitted(s.call, 'screen.frame')).toHaveLength(1);

    s.button()!.onClick();
    expect(s.fs.track.stop).toHaveBeenCalled();
    expect(emitted(s.call, 'screen.state').at(-1)).toEqual({ on: false });
    expect(s.button()!.active).toBe(false);
    s.call.emit.mockClear();
    await vi.advanceTimersByTimeAsync(10000);
    expect(s.call.emit).not.toHaveBeenCalled();
    s.r.stop();
  });

  it('見ている人がいない（自分だけ）ときは送らない', async () => {
    const s = await setup({ display: true });
    s.call.participants = [{ peer: 'me', self: true }];
    s.button()!.onClick();
    await vi.advanceTimersByTimeAsync(3000);
    expect(emitted(s.call, 'screen.frame')).toHaveLength(0);
    s.r.stop();
  });

  it('OS 側でトラックが終わったら止まる', async () => {
    const s = await setup({ display: true });
    s.button()!.onClick();
    await vi.advanceTimersByTimeAsync(1);
    s.fs.end();
    expect(s.button()!.active).toBe(false);
    expect(emitted(s.call, 'screen.state').at(-1)).toEqual({ on: false });
    s.r.stop();
  });

  it('通話から抜けたら共有を止め、見ていた表示も消す', async () => {
    const s = await setup({ display: true });
    s.fire('screen.state', 'pa', 'a', { on: true });
    s.status().querySelector('button')!.click();
    expect(document.querySelector('.screenshare-overlay')).not.toBeNull();
    s.button()!.onClick();
    await vi.advanceTimersByTimeAsync(1);

    s.call.joined = false;
    s.changed();
    expect(s.fs.track.stop).toHaveBeenCalled();
    expect(s.button()!.active).toBe(false);
    expect(document.querySelector('.screenshare-overlay')).toBeNull();
    // 抜けたあとは state も送らない（送ると例外になる）
    expect(emitted(s.call, 'screen.state').filter((p) => p.on === false)).toHaveLength(0);
    s.r.stop();
  });

  it('許可待ちのあいだに通話を抜けたら、取得した画面を捨てる', async () => {
    const s = await setup({ display: true });
    s.getDisplayMedia.mockImplementationOnce(async () => {
      s.call.joined = false;
      return s.fs.stream;
    });
    s.button()!.onClick();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.fs.track.stop).toHaveBeenCalled();
    expect(s.call.emit).not.toHaveBeenCalled();
    s.r.stop();
  });

  it('複数人が共有したら切り替えられ、止めた人・抜けた人は消える', async () => {
    const s = await setup({ display: false });
    s.call.participants.push({ peer: 'pb', self: false });
    s.fire('screen.state', 'pa', 'a', { on: true });
    s.fire('screen.state', 'pb', 'b', { on: true });
    s.fire('screen.frame', 'pa', 'a', { f: 0, i: 0, n: 1, d: 'QUFB' });
    s.fire('screen.frame', 'pb', 'b', { f: 0, i: 0, n: 1, d: 'QkJC' });
    const buttons = s.status().querySelectorAll('button');
    expect(buttons).toHaveLength(2);
    buttons[0].click();
    const src = () => document.querySelector<HTMLImageElement>('.screenshare-overlay img')?.getAttribute('src');
    expect(src()).toContain('QUFB');
    // 上のタブでボブに切り替える
    document.querySelectorAll<HTMLButtonElement>('.screenshare-tab')[1].click();
    expect(src()).toContain('QkJC');

    // 見ているボブが止めたら、アリスに移る
    s.fire('screen.state', 'pb', 'b', { on: false });
    expect(src()).toContain('QUFB');
    // アリスが通話から抜けたら、表示ごと消える
    s.call.participants = [{ peer: 'me', self: true }];
    s.changed();
    expect(document.querySelector('.screenshare-overlay')).toBeNull();
    expect(s.status().querySelectorAll('button')).toHaveLength(0);
    s.r.stop();
  });

  it('音沙汰のない共有者は一定時間で消える', async () => {
    const s = await setup({ display: false });
    s.fire('screen.state', 'pa', 'a', { on: true });
    expect(s.status().querySelectorAll('button')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(12000);
    expect(s.status().querySelectorAll('button')).toHaveLength(0);
    s.r.stop();
  });

  it('Esc で閉じる', async () => {
    const s = await setup({ display: false });
    s.fire('screen.state', 'pa', 'a', { on: true });
    s.status().querySelector('button')!.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.screenshare-overlay')).toBeNull();
    s.r.stop();
  });
});
