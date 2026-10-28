// @vitest-environment jsdom
// 通話のストアを2〜3人分作り、サーバーの代わりの中継（参加者の管理・call.emit・kick）でつないで、
// サーバー経由の音声（リレー）・ミュート・kick・再接続・拡張 API を確かめる
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallMember } from '../protocol/CallMember';
import type { ClientEvent } from '../protocol/ClientEvent';
import type { ServerEvent } from '../protocol/ServerEvent';
import { createCallApi } from './api';
import { CallSettings, createCallSource } from './settings.svelte';
import { dbToLinear, pcmToBase64 } from './pure';
import { CallStore, type CallDeps } from './store.svelte';

// マイクの取り出しは本物の AudioContext が要るので、偽物にする（音は store の onCapture に直接渡す）
vi.mock('./capture', () => ({ startCapture: () => ({ stop() {} }) }));

// ---- 偽物 ----

let seq = 0;

class FakeTrack {
  id = `t${++seq}`;
  enabled = true;
  readyState = 'live';
  muted = false;
  private handlers = new Map<string, Set<() => void>>();
  constructor(public kind: 'audio' | 'video') {}
  stop() {}
  addEventListener(type: string, fn: () => void) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: () => void) {
    this.handlers.get(type)?.delete(fn);
  }
  /** テストから状態変化を起こす */
  fire(type: string) {
    for (const f of [...(this.handlers.get(type) ?? [])]) f();
  }
  listenerCount() {
    let n = 0;
    for (const set of this.handlers.values()) n += set.size;
    return n;
  }
}

class FakeStream {
  id = `s${++seq}`;
  constructor(public tracks: FakeTrack[] = []) {}
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
}

class FakeAudioContext {
  state = 'running';
  sampleRate = 48000;
  currentTime = 0;
  destination = {};
  /** 鳴らした音の数 */
  plays = 0;
  buffers: Float32Array[] = [];
  shapers: { curve: Float32Array | null; connect: ReturnType<typeof vi.fn> }[] = [];
  createBuffer(_ch: number, n: number) {
    const data = new Float32Array(n);
    this.buffers.push(data);
    return { getChannelData: () => data };
  }
  createWaveShaper() {
    const node = { curve: null as Float32Array | null, connect: vi.fn() };
    this.shapers.push(node);
    return node;
  }
  createBufferSource() {
    return { buffer: null, connect: () => {}, start: () => void this.plays++ };
  }
  createGain() {
    return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} };
  }
  createMediaStreamDestination() {
    return { stream: new FakeStream([new FakeTrack('audio')]) };
  }
  createAnalyser() {
    return { fftSize: 0, getByteTimeDomainData: (b: Uint8Array) => b.fill(128), connect: () => {} };
  }
  createMediaStreamSource() {
    return { connect: () => {} };
  }
  async resume() {}
  async close() {}
}

// ---- サーバーの代わり ----

type Client = { store: CallStore; settings: CallSettings; userId: string; conn: number; toast: ReturnType<typeof vi.fn>; confirm: ReturnType<typeof vi.fn>; hold: ReturnType<typeof vi.fn>; sent: ClientEvent[]; failService: () => void; serviceOff: ReturnType<typeof vi.fn> };

class FakeServer {
  clients: Client[] = [];
  members = new Map<number, CallMember>();

  private deliver(c: Client, ev: unknown) {
    const copy = JSON.parse(JSON.stringify(ev)) as ServerEvent;
    queueMicrotask(() => c.store.onServerEvent(copy));
  }
  private broadcastState() {
    const members = [...this.members.values()].sort((a, b) => a.peer.localeCompare(b.peer));
    for (const c of this.clients) this.deliver(c, { type: 'call.state', members });
  }
  /** 接続が切れた */
  drop(c: Client) {
    if (!this.members.delete(c.conn)) return;
    // 切れた接続には届かない（実際のサーバーと同じ）
    const members = [...this.members.values()].sort((x, y) => x.peer.localeCompare(y.peer));
    for (const x of this.clients) if (x !== c) this.deliver(x, { type: 'call.state', members });
  }
  /** 自分から抜ける（接続は生きているので、自分にも一覧が届く） */
  leave(c: Client) {
    if (this.members.delete(c.conn)) this.broadcastState();
  }
  handle(c: Client, ev: ClientEvent) {
    c.sent.push(ev);
    switch (ev.type) {
      case 'call.join': {
        // サーバーと同じ: 別の接続（半開きの前の接続を含む）が同じ peer を持っていれば入れない
        const taken = [...this.members.entries()].some(([conn, m]) => conn !== c.conn && m.peer === ev.peer);
        if (taken) {
          this.deliver(c, { type: 'error', code: 'peer_in_use', message: 'その接続 ID はすでに使われています' });
          break;
        }
        this.members.set(c.conn, { peer: ev.peer, user_id: c.userId, status: ev.status });
        this.broadcastState();
        break;
      }
      case 'call.leave':
        this.leave(c);
        break;
      case 'call.update': {
        const m = this.members.get(c.conn);
        if (m) m.status = ev.status;
        this.broadcastState();
        break;
      }
      case 'call.kick': {
        const target = this.clients.find((x) => this.members.get(x.conn)?.peer === ev.peer);
        if (!target || !this.members.has(c.conn)) break;
        this.members.delete(target.conn);
        this.deliver(target, { type: 'call.kicked', by: c.userId });
        this.broadcastState();
        break;
      }
      case 'call.emit': {
        const me = this.members.get(c.conn);
        if (!me) break;
        for (const x of this.clients) {
          if (x !== c && this.members.has(x.conn)) this.deliver(x, { type: 'call.event', peer: me.peer, from: c.userId, name: ev.name, payload: ev.payload });
        }
        break;
      }
    }
  }
}

const names: Record<string, string> = { u1: 'Alice', u2: 'Bob', u3: 'Carol' };
let server: FakeServer;

function makeClient(userId: string, opts: { device?: string } = {}): Client {
  const toast = vi.fn();
  const confirm = vi.fn(async () => true);
  const hold = vi.fn(async () => Object.assign(() => {}, { update: vi.fn() }));
  const serviceCbs = new Set<() => void>();
  const serviceOff = vi.fn();
  const client = { userId, conn: server.clients.length + 1, toast, confirm, hold, sent: [] as ClientEvent[], serviceOff } as Client;
  // 前景サービスが後から失敗したことを、テストから起こす
  client.failService = () => serviceCbs.forEach((f) => f());
  client.settings = new CallSettings(createCallSource());
  const deps: CallDeps = {
    send: (ev) => server.handle(client, ev),
    meId: () => userId,
    nameOf: (id) => names[id] ?? '不明なユーザー',
    toast,
    confirm,
    hold,
    onServiceFailed: (cb) => {
      serviceCbs.add(cb);
      return () => {
        serviceCbs.delete(cb);
        serviceOff();
      };
    },
    audio: {
      listOutputs: async () => [
        { id: 'earpiece', label: '受話口', kind: 'earpiece', selected: false },
        { id: 'speaker', label: 'スピーカー', kind: 'speaker', selected: true },
      ],
      setOutput: async () => true,
      listInputs: async () => [],
      attach: () => () => {},
    },
    settings: client.settings,
    deviceKind: () => opts.device ?? 'laptop',
    openSettings: () => {},
    now: () => performance.now(),
  };
  client.store = new CallStore(deps);
  server.clients.push(client);
  return client;
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((res) => setTimeout(res, 0));
};

beforeEach(() => {
  seq = 0;
  server = new FakeServer();
  localStorage.clear();
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('MediaStream', FakeStream);
  vi.stubGlobal('Worker', class { onmessage = null; terminate() {} });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => new FakeStream([new FakeTrack('audio')]) },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 2人が参加するまで進める */
async function connect(a: Client, b: Client) {
  await a.store.join();
  await b.store.join();
  await flush();
}

/** 自分の声（大きい音）を送らせる。送られた audio の payload を返す */
function speak(c: Client): { seq: number; pcm: string }[] {
  const store = c.store as unknown as { onCapture(chunk: Float32Array): void };
  c.store.tick(); // 相手がいれば、ここで声を取り出し始める
  const before = c.sent.length;
  store.onCapture(new Float32Array(48000 * 0.2).fill(0.3));
  return c.sent
    .slice(before)
    .filter((e) => e.type === 'call.emit' && e.name === 'audio')
    .map((e) => (e as { payload: { seq: number; pcm: string } }).payload);
}

const plays = (c: Client) => (c.store as unknown as { ctx: FakeAudioContext }).ctx.plays;
const gainOf = (c: Client, peer: string) =>
  (c.store as unknown as { entries: Map<string, { relay: { gain: { gain: { value: number } } } | null }> }).entries.get(peer)!.relay!.gain.gain.value;

describe('参加と音声', () => {
  it("実験用の localStorage 'disnans.micRaw'='1' なら、次の参加からエコー消去などを切って開く", async () => {
    const gum = vi.fn(async (_c: unknown) => new FakeStream([new FakeTrack('audio')]));
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: gum } });
    const a = makeClient('u1');
    await a.store.join();
    expect(gum.mock.calls[0][0]).toMatchObject({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    a.store.leave();
    localStorage.setItem('disnans.micRaw', '1');
    await a.store.join();
    expect(gum.mock.calls[1][0]).toMatchObject({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    localStorage.removeItem('disnans.micRaw');
  });

  it("AudioContext は 48000Hz・interactive で作る。'disnans.ctxRate' で上書きできる（不正なら既定）", async () => {
    const opts: unknown[] = [];
    class Spy extends FakeAudioContext {
      constructor(o?: unknown) {
        super();
        opts.push(o);
      }
    }
    vi.stubGlobal('AudioContext', Spy);
    const a = makeClient('u1');
    await a.store.join();
    expect(opts[0]).toEqual({ sampleRate: 48000, latencyHint: 'interactive' });
    a.store.leave();
    localStorage.setItem('disnans.ctxRate', '44100');
    await a.store.join();
    expect(opts[1]).toEqual({ sampleRate: 44100, latencyHint: 'interactive' });
    a.store.leave();
    localStorage.setItem('disnans.ctxRate', 'bogus');
    await a.store.join();
    expect(opts[2]).toEqual({ sampleRate: 48000, latencyHint: 'interactive' });
    localStorage.removeItem('disnans.ctxRate');
  });

  it("'disnans.noKeepAlive'='1' なら keep-alive（発振）を動かさない", async () => {
    const made = vi.fn();
    const osc = () => {
      made();
      return { frequency: { value: 0 }, connect: () => ({ connect: () => {} }), start: () => {}, stop: () => {} };
    };
    const fake = FakeAudioContext.prototype as unknown as Record<string, unknown>;
    const gainOrig = fake.createGain;
    fake.createOscillator = osc;
    fake.createGain = () => ({ gain: { value: 0 }, connect: () => ({ connect: () => {} }) });
    try {
      localStorage.setItem('disnans.noKeepAlive', '1');
      const a = makeClient('u1');
      await a.store.join();
      expect(made).not.toHaveBeenCalled();
      a.store.leave();
      localStorage.removeItem('disnans.noKeepAlive');
      await a.store.join();
      expect(made).toHaveBeenCalled();
    } finally {
      delete fake.createOscillator;
      fake.createGain = gainOrig;
    }
  });

  it('参加中は 5 秒ごとに時計のずれを出す（ctx と壁の時計）', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const a = makeClient('u1');
    await a.store.join();
    const priv = a.store as unknown as { ctx: { currentTime: number }; ensureCapture: () => void };
    const ctx = priv.ctx;
    priv.ensureCapture(); // 取り始める（相手がいるときと同じ）
    ctx.currentTime = 1;
    a.store.tick();
    ctx.currentTime = 6;
    a.store.tick();
    const lines = info.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[call] 時計'));
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toContain('ずれ(ctx-実)');
    info.mockRestore();
  });

  it('マイクの最初のデータと、最初の大きい音を、開いてから 1 回ずつ出す', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const a = makeClient('u1');
    await a.store.join();
    const meter = (a.store as unknown as { localMeter: { analyser: { getByteTimeDomainData: (b: Uint8Array) => void } } }).localMeter;
    meter.analyser.getByteTimeDomainData = (b: Uint8Array) => b.fill(255); // 大きい音
    a.store.tick();
    a.store.tick();
    const lines = info.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes('最初のデータまで'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('最初の大きい音まで'))).toHaveLength(1);
    info.mockRestore();
  });

  it('参加すると参加していない人にも見え、抜けると消える。接続を作らず、双方の声がサーバー経由で届く', async () => {
    const a = makeClient('u1');
    const b = makeClient('u2');
    expect(a.store.visible).toBe(false);
    await a.store.join();
    await flush();
    expect(a.store.joined).toBe(true);
    expect(a.hold).toHaveBeenCalledWith(expect.objectContaining({ microphone: true }));
    expect(b.store.visible).toBe(true);
    expect(b.store.joined).toBe(false);
    expect(b.store.participants.map((p) => p.userId)).toEqual(['u1']);

    await b.store.join();
    await flush();
    expect(a.store.participants[0]).toMatchObject({ self: true, userId: 'u1' });
    expect(a.store.participants[1]).toMatchObject({ self: false, userId: 'u2', connected: true });

    expect(speak(a).length).toBeGreaterThan(0);
    expect(speak(b).length).toBeGreaterThan(0);
    await flush();
    expect(plays(b)).toBeGreaterThan(0);
    expect(plays(a)).toBeGreaterThan(0);

    b.store.leave();
    await flush();
    expect(b.store.joined).toBe(false);
    expect(a.store.participants.map((p) => p.userId)).toEqual(['u1']);
    a.store.leave();
    await flush();
    expect(a.store.visible).toBe(false);
  });

  it('3人でそれぞれの声が、自分以外の全員に届く', async () => {
    const a = makeClient('u1');
    const b = makeClient('u2');
    const c = makeClient('u3');
    await a.store.join();
    await b.store.join();
    await c.store.join();
    await flush();
    speak(a);
    await flush();
    expect(plays(b)).toBeGreaterThan(0);
    expect(plays(c)).toBeGreaterThan(0);
    expect(plays(a)).toBe(0);
  });

  it('大きい受信音を既定で抑え、設定変更とオフ・オンが次のフレームに効く', async () => {
    const a = makeClient('u1');
    const b = makeClient('u2');
    await connect(a, b);
    const ctx = (b.store as unknown as { ctx: FakeAudioContext }).ctx;
    const hot = pcmToBase64(new Int16Array(800).fill(32767));
    const send = async (pcm = hot) => {
      server.handle(a, { type: 'call.emit', name: 'audio', payload: { pcm } });
      await flush();
      return ctx.buffers.at(-1)!;
    };
    const peak = (data: Float32Array) => data.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peak(await send())).toBeLessThanOrEqual(dbToLinear(-6) + 1e-6);
    expect(ctx.shapers).toHaveLength(1);
    expect(ctx.shapers[0]!.connect).toHaveBeenCalledWith(ctx.destination);
    expect(peak(ctx.shapers[0]!.curve!)).toBeCloseTo(dbToLinear(-6), 6);
    b.settings.patch({ limitDb: -12 });
    expect(peak(await send())).toBeLessThanOrEqual(dbToLinear(-12) + 1e-6);
    expect(peak(ctx.shapers[0]!.curve!)).toBeCloseTo(dbToLinear(-12), 6);
    b.settings.patch({ limiter: false });
    expect(peak(await send())).toBeGreaterThan(0.99);
    expect(ctx.shapers[0]!.curve).toBeNull();
    b.settings.patch({ limiter: true });
    // オフにする前の先読みの大きい音が残っていない
    expect(peak(await send(pcmToBase64(new Int16Array(800))))).toBe(0);
    expect(ctx.shapers).toHaveLength(1);
  });

  it('1人だけのあいだは声を送らない。無音も送らない', async () => {
    const a = makeClient('u1');
    await a.store.join();
    expect(speak(a)).toHaveLength(0);
    const b = makeClient('u2');
    await b.store.join();
    await flush();
    const store = a.store as unknown as { onCapture(chunk: Float32Array): void };
    a.store.tick();
    const before = a.sent.length;
    store.onCapture(new Float32Array(48000 * 2));
    expect(a.sent.length).toBe(before);
  });

  it('ミュート中は声を送らず、スピーカーミュートや自分の側だけの消音では相手の音を鳴らさない', async () => {
    const a = makeClient('u1');
    const b = makeClient('u2');
    await connect(a, b);
    a.store.toggleMute();
    expect(speak(a)).toHaveLength(0);
    a.store.toggleMute();
    expect(speak(a).length).toBeGreaterThan(0);
    await flush();
    const peerA = a.store.myPeer;
    expect(gainOf(b, peerA)).toBe(1);
    b.store.toggleLocalMute(peerA);
    expect(gainOf(b, peerA)).toBe(0);
    b.store.toggleLocalMute(peerA);
    b.store.toggleDeafen();
    expect(gainOf(b, peerA)).toBe(0);
    // 消している間は、届いても鳴らさない
    const n = plays(b);
    speak(a);
    await flush();
    expect(plays(b)).toBe(n);
    b.store.toggleDeafen();
    expect(gainOf(b, peerA)).toBe(1);
    // 相手がミュートの表示なら、届いても鳴らさない
    a.store.toggleMute();
    await flush();
    const m = plays(b);
    const store = a.store as unknown as { muted: boolean };
    store.muted = false; // 古い音声が遅れて届いた想定
    speak(a);
    await flush();
    expect(plays(b)).toBe(m);
  });

  it('マイクを使えない環境ではトーストを出して参加しない', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    const a = makeClient('u1');
    await a.store.join();
    expect(a.store.joined).toBe(false);
    expect(a.toast).toHaveBeenCalledWith(expect.stringContaining('マイク'), 'error');
    expect(a.sent).toHaveLength(0);
  });

  it('スピーカーミュートを入れるとミュートも入り、外すとスピーカーミュートが入れたミュートも外れる', async () => {
    const a = makeClient('u1');
    const b = makeClient('u2');
    await connect(a, b);
    a.store.toggleDeafen();
    expect(a.store.deafened).toBe(true);
    expect(a.store.muted).toBe(true);
    a.store.toggleDeafen();
    expect(a.store.deafened).toBe(false);
    expect(a.store.muted).toBe(false);
  });

  it('先に自分でミュートしていたら、スピーカーミュートを外してもミュートのまま', async () => {
    const a = makeClient('u1');
    const b = makeClient('u2');
    await connect(a, b);
    a.store.toggleMute();
    a.store.toggleDeafen();
    expect(a.store.muted).toBe(true);
    expect(a.store.deafened).toBe(true);
    a.store.toggleDeafen();
    expect(a.store.deafened).toBe(false);
    expect(a.store.muted).toBe(true);
  });

  it('スピーカーミュート中にミュートを外すと、スピーカーミュートも外れる（ミュートなしのスピーカーミュートは作らない）', async () => {
    const a = makeClient('u1');
    const b = makeClient('u2');
    await connect(a, b);
    a.store.toggleDeafen();
    a.store.toggleMute();
    expect(a.store.muted).toBe(false);
    expect(a.store.deafened).toBe(false);
    // もう一度: 外したあとにスピーカーミュートを入れ直すと、ミュートも入る
    a.store.toggleDeafen();
    expect(a.store.muted).toBe(true);
    expect(a.store.deafened).toBe(true);
  });

  it('どの順の操作でも、スピーカーミュート中はミュートが入っている（全 64 通り）', async () => {
    for (let bits = 0; bits < 64; bits++) {
      const a = makeClient('u1');
      const b = makeClient('u2');
      await connect(a, b);
      for (let i = 0; i < 6; i++) {
        if ((bits >> i) & 1) a.store.toggleDeafen();
        else a.store.toggleMute();
        if (a.store.deafened) expect(a.store.muted, `操作 ${bits.toString(2)} の ${i} 手目`).toBe(true);
      }
      a.store.leave();
      b.store.leave();
    }
  });

  it('ミュート・スピーカーミュート・デバイスの種類は参加者に共有される', async () => {
    const a = makeClient('u1', { device: 'smartphone' });
    const b = makeClient('u2');
    await connect(a, b);
    expect(b.store.participants.find((p) => p.userId === 'u1')).toMatchObject({ muted: false, deafened: false, device: 'smartphone' });
    a.store.toggleMute();
    a.store.toggleDeafen();
    await flush();
    expect(b.store.participants.find((p) => p.userId === 'u1')).toMatchObject({ muted: true, deafened: true });
    expect(a.store.participants[0]).toMatchObject({ muted: true, deafened: true });
  });

  it('参加したときミュートにする設定が効く', async () => {
    const a = makeClient('u1');
    a.store['deps'].settings.patch({ joinMuted: true });
    await a.store.join();
    expect(a.store.muted).toBe(true);
    expect(a.sent.find((e) => e.type === 'call.join')).toMatchObject({ status: { muted: true } });
  });

  it('つなぎ直す（hello）で新しい peer ID で入り直し、また声が届く', async () => {
    const a = makeClient('u1');
    const b = makeClient('u2');
    await connect(a, b);
    const peerA = a.store.myPeer;
    // A の接続が切れて、サーバーから外れた
    server.drop(a);
    await flush();
    expect(b.store.participants.map((p) => p.userId)).toEqual(['u2']);
    a.store.onServerEvent({ type: 'hello', me: { id: 'u1' } as never, users: [] });
    await flush();
    expect(a.store.myPeer).not.toBe(peerA);
    expect(b.store.participants.map((p) => p.userId).sort()).toEqual(['u1', 'u2']);
    speak(a);
    await flush();
    expect(plays(b)).toBeGreaterThan(0);
  });

  it('サーバーがまだ前の参加（同じ peer）を持っていても、つなぎ直しは通る（peer を変えて入る）', async () => {
    const a = makeClient('u1');
    const b = makeClient('u2');
    await connect(a, b);
    const before = a.store.myPeer;
    // 前の接続は外れていない（半開き）。hello で入り直す
    a.store.onServerEvent({ type: 'hello', me: { id: 'u1' } as never, users: [] });
    await flush();
    expect(a.store.myPeer).not.toBe(before);
    expect(a.sent.filter((e) => e.type === 'call.join').at(-1)).toMatchObject({ peer: a.store.myPeer });
    expect(a.store.joined).toBe(true);
    // 入れなかった（peer_in_use）ことを示す error は届いていない（toast が出ていない）
    expect(a.toast).not.toHaveBeenCalledWith(expect.stringContaining('すでに使われて'), 'error');
    expect(b.store.participants.map((p) => p.userId)).toContain('u1');
  });

  it('一覧に載るまで音声を送らない（join より先に call.emit が着くと not_in_call になるため）', async () => {
    vi.useFakeTimers();
    try {
      const b = makeClient('u2');
      await b.store.join();
      await vi.advanceTimersByTimeAsync(0);
      const a = makeClient('u1');
      const realHandle = server.handle.bind(server);
      let swallow = true;
      server.handle = (c, ev) => (swallow && ev.type === 'call.join' ? undefined : realHandle(c, ev));
      await a.store.join();
      // 相手が居るので、音声の送信の条件（相手の接続）は満たしている。でも一覧に載る前なので送らない
      expect(speak(a)).toEqual([]);
      swallow = false;
      a.store.onServerEvent({ type: 'call.state', members: [{ peer: a.store.myPeer, user_id: 'u1', status: { muted: false, deafened: false, device: null } }, ...b.store.members] } as never);
      expect(speak(a).length).toBeGreaterThan(0);
      server.handle = realHandle;
    } finally {
      vi.useRealTimers();
    }
  });

  it('プラグインの emit は、一覧に載るまで積んで、載ったら順に送る', async () => {
    vi.useFakeTimers();
    try {
      const a = makeClient('u1');
      const realHandle = server.handle.bind(server);
      let swallow = true;
      server.handle = (c, ev) => (swallow && ev.type === 'call.join' ? undefined : realHandle(c, ev));
      await a.store.join();
      a.store.emit('frame', { n: 1 });
      a.store.emit('frame', { n: 2 });
      expect(a.sent.some((e) => e.type === 'call.emit')).toBe(false);
      swallow = false;
      a.store.onServerEvent({ type: 'call.state', members: [{ peer: a.store.myPeer, user_id: 'u1', status: { muted: false, deafened: false, device: null } }] } as never);
      const emits = a.sent.filter((e) => e.type === 'call.emit');
      expect(emits.map((e) => (e as { payload: unknown }).payload)).toEqual([{ n: 1 }, { n: 2 }]);
      server.handle = realHandle;
    } finally {
      vi.useRealTimers();
    }
  });

  it('一覧に載らないまま待つと、積んだ emit は捨てる（例外にはしない）。上限を超えたものも捨てる', async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const a = makeClient('u1');
      const realHandle = server.handle.bind(server);
      server.handle = (c, ev) => (ev.type === 'call.join' ? undefined : realHandle(c, ev));
      await a.store.join();
      expect(() => {
        for (let i = 0; i < 60; i++) a.store.emit('frame', { n: i });
      }).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('一覧に載るまでの送信が多いので捨てました'));
      // 3 秒の一覧待ちで参加は失敗し、通話から抜けるときに積んだ emit も捨てる（5 秒の上限は後ろ盾）
      await vi.advanceTimersByTimeAsync(3100);
      expect(a.store.joined).toBe(false);
      expect(a.sent.some((e) => e.type === 'call.emit')).toBe(false);
      server.handle = realHandle;
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('not_in_call の警告に、直近に送った call.* を添える（種別と経過ms。音声は連続をまとめる）', async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const a = makeClient('u1');
      const realHandle = server.handle.bind(server);
      server.handle = (c, ev) => (ev.type === 'call.join' ? undefined : realHandle(c, ev));
      await a.store.join();
      a.store.emit('frame', { n: 1 });
      a.store.onServerEvent({ type: 'error', client_id: null, code: 'not_in_call', message: '通話に参加していません' } as never);
      const line = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('code=not_in_call'))!;
      expect(line).toContain('直近の送信=call.join@0ms');
      server.handle = realHandle;
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('一覧に載る前は、相手の kick を送らない', async () => {
    const a = makeClient('u1');
    const b = makeClient('u2');
    await connect(a, b);
    const bPeer = b.store.myPeer;
    a.store.onServerEvent({ type: 'call.state', members: [{ peer: a.store.myPeer, user_id: 'u1', status: { muted: false, deafened: false, device: null } }, { peer: bPeer, user_id: 'u2', status: { muted: false, deafened: false, device: null } }] } as never);
    a.store.onServerEvent({ type: 'hello', me: { id: 'u1' } as never, users: [] });
    expect(a.store.listed).toBe(false);
    a.sent.length = 0;
    await a.store.kick(bPeer);
    expect(a.sent.some((e) => e.type === 'call.kick')).toBe(false);
  });

  it('一覧に載る前の not_in_call では抜けない（音声・状態への応答の可能性。3 秒の待ちで判定する）', async () => {
    vi.useFakeTimers();
    try {
      const a = makeClient('u1');
      const realHandle = server.handle.bind(server);
      server.handle = (c, ev) => (ev.type === 'call.join' ? undefined : realHandle(c, ev));
      await a.store.join();
      a.store.onServerEvent({ type: 'error', code: 'not_in_call', message: '通話に参加していません' } as never);
      expect(a.store.joined).toBe(true);
      expect(a.toast).not.toHaveBeenCalledWith(expect.stringContaining('通話に入れませんでした'), 'error');
      server.handle = realHandle;
    } finally {
      vi.useRealTimers();
    }
  });

  it('再入り直し（rejoin）の直後も、一覧に載るまで音声を送らない', async () => {
    const a = makeClient('u1');
    const b = makeClient('u2');
    await connect(a, b);
    expect(speak(a).length).toBeGreaterThan(0);
    a.store.onServerEvent({ type: 'hello', me: { id: 'u1' } as never, users: [] });
    // 入り直しの送信のあと、まだ一覧に載っていない
    expect(a.store.listed).toBe(false);
    expect(speak(a)).toEqual([]);
    await flush();
    expect(a.store.listed).toBe(true);
    expect(speak(a).length).toBeGreaterThan(0);
  });

  it('参加中に変えた状態（ミュート）は、一覧に載った時点で一度送る', async () => {
    vi.useFakeTimers();
    try {
      const a = makeClient('u1');
      const realHandle = server.handle.bind(server);
      let swallow = true;
      server.handle = (c, ev) => (swallow && ev.type === 'call.join' ? undefined : realHandle(c, ev));
      await a.store.join();
      a.store.toggleMute();
      expect(a.sent.some((e) => e.type === 'call.update')).toBe(false);
      swallow = false;
      a.store.onServerEvent({ type: 'call.state', members: [{ peer: a.store.myPeer, user_id: 'u1', status: { muted: false, deafened: false, device: null } }] } as never);
      expect(a.sent.filter((e) => e.type === 'call.update').at(-1)).toMatchObject({ status: { muted: true } });
      server.handle = realHandle;
    } finally {
      vi.useRealTimers();
    }
  });

  it('参加を送ったあいだは「参加中」（自分は出さない）。一覧に載ると参加済み', async () => {
    vi.useFakeTimers();
    try {
      const a = makeClient('u1');
      const realHandle = server.handle.bind(server);
      let swallow = true;
      server.handle = (c, ev) => (swallow && ev.type === 'call.join' ? undefined : realHandle(c, ev));
      await a.store.join();
      expect(a.store.joined).toBe(true);
      expect(a.store.listed).toBe(false);
      expect(a.store.pending).toBe(true);
      expect(a.store.participants.some((p) => p.self)).toBe(false);
      // 届いて一覧に載った
      swallow = false;
      a.store.onServerEvent({ type: 'call.state', members: [{ peer: a.store.myPeer, user_id: 'u1', status: { muted: false, deafened: false, device: null } }] } as never);
      expect(a.store.pending).toBe(false);
      expect(a.store.participants[0]).toMatchObject({ self: true, userId: 'u1' });
      server.handle = realHandle;
    } finally {
      vi.useRealTimers();
    }
  });

  it('一覧に載らないまま 3 秒たつと、通話を閉じて理由を toast する（「通話に参加していません」は出さない）', async () => {
    vi.useFakeTimers();
    try {
      const a = makeClient('u1');
      const realHandle = server.handle.bind(server);
      server.handle = (c, ev) => (ev.type === 'call.join' ? undefined : realHandle(c, ev));
      await a.store.join();
      await vi.advanceTimersByTimeAsync(3100);
      expect(a.store.joined).toBe(false);
      expect(a.store.pending).toBe(false);
      expect(a.toast).toHaveBeenCalledWith(expect.stringContaining('通話に入れませんでした（サーバーから返事がありませんでした）'), 'error');
      expect(a.toast).not.toHaveBeenCalledWith(expect.stringContaining('通話に参加していません'), 'error');
      server.handle = realHandle;
    } finally {
      vi.useRealTimers();
    }
  });

  it('一覧に載ったあとで、サーバーが「通話に参加していません」を返したら、一度だけ入り直す。また外れたら通話から外れる', async () => {
    const a = makeClient('u1');
    await a.store.join();
    await flush();
    expect(a.store.listed).toBe(true);
    a.store.onServerEvent({ type: 'error', code: 'not_in_call', message: '通話に参加していません' } as never);
    await flush();
    expect(a.store.joined).toBe(true);
    expect(a.store.listed).toBe(true);
    expect(a.toast).not.toHaveBeenCalledWith('通話から外れました', 'info');
    expect(a.toast).not.toHaveBeenCalledWith(expect.stringContaining('通話に参加していません'), 'error');

    a.store.onServerEvent({ type: 'error', code: 'not_in_call', message: '通話に参加していません' } as never);
    await flush();
    expect(a.store.joined).toBe(false);
    expect(a.toast).toHaveBeenCalledWith(expect.stringContaining('通話から外れました'), 'info');
  });

  it('一覧から自分が消えたら（サーバーが外した）、一度だけ入り直す。入り直しても外れたら通話から外れる', async () => {
    const a = makeClient('u1');
    await a.store.join();
    await flush();
    const firstPeer = a.store.myPeer;
    a.store.onServerEvent({ type: 'call.state', members: [] } as never);
    // 入り直しは新しい peer ID で join を送る。サーバーの一覧に戻る
    expect(a.store.joined).toBe(true);
    expect(a.sent.filter((e) => e.type === 'call.join').length).toBe(2);
    await flush();
    expect(a.store.listed).toBe(true);
    expect(a.store.myPeer).not.toBe(firstPeer);
    expect(a.toast).not.toHaveBeenCalledWith('通話から外れました', 'info');

    // 2 度目に外されたら、もう入り直さない
    a.store.onServerEvent({ type: 'call.state', members: [] } as never);
    expect(a.store.joined).toBe(false);
    expect(a.toast).toHaveBeenCalledWith(expect.stringContaining('通話から外れました'), 'info');
  });

  it('静かに入り直したときは、再接続したことを 1 回知らせる（接続が戻ったため）', async () => {
    const a = makeClient('u1');
    await a.store.join();
    await flush();
    a.toast.mockClear();
    a.store.onServerEvent({ type: 'hello' } as never);
    await flush();
    expect(a.store.joined).toBe(true);
    expect(a.toast).toHaveBeenCalledWith('通話に再接続しました（接続が戻ったため）', 'info');
    expect(a.toast).toHaveBeenCalledTimes(1);
  });

  it('一覧から外れて入り直したときも、再接続を知らせる（理由つき）。外れたときは理由を知らせる', async () => {
    const a = makeClient('u1');
    await a.store.join();
    await flush();
    a.toast.mockClear();
    a.store.onServerEvent({ type: 'call.state', members: [] } as never);
    expect(a.toast).toHaveBeenCalledWith('通話に再接続しました（サーバーの一覧から外れていたため）', 'info');
    await flush();
    expect(a.store.listed).toBe(true);
  });

  it('接続が切れていたあとに外れたら、理由は ws_closed。切れていなければ server_removed', async () => {
    const a = makeClient('u1');
    await a.store.join();
    await flush();
    a.store.onLink(false);
    a.store.onServerEvent({ type: 'call.state', members: [] } as never);
    await flush();
    a.toast.mockClear();
    a.store.onServerEvent({ type: 'call.state', members: [] } as never);
    expect(a.store.joined).toBe(false);
    expect(a.toast).toHaveBeenCalledWith('通話から外れました（理由: ws_closed）', 'info');

    const b = makeClient('u2');
    await b.store.join();
    await flush();
    b.store.onServerEvent({ type: 'call.state', members: [] } as never);
    await flush();
    b.toast.mockClear();
    b.store.onServerEvent({ type: 'call.state', members: [] } as never);
    expect(b.toast).toHaveBeenCalledWith('通話から外れました（理由: server_removed）', 'info');
  });

  it('自分で抜けたときは、理由の知らせは出さない', async () => {
    const a = makeClient('u1');
    await a.store.join();
    await flush();
    a.toast.mockClear();
    a.store.leave(true, 'user');
    expect(a.toast).not.toHaveBeenCalled();
  });

  it('前景サービスを始められなかったら（常駐が throw）、バックグラウンドで切れうることを 1 回だけ知らせ、通話は続ける', async () => {
    const a = makeClient('u1');
    a.hold.mockRejectedValueOnce(new Error('start not allowed'));
    await a.store.join();
    await flush();
    expect(a.store.joined).toBe(true);
    expect(a.toast).toHaveBeenCalledWith('バックグラウンドでは通話が切れることがあります', 'info');
    expect(a.toast.mock.calls.filter((c) => String(c[0]).includes('バックグラウンド'))).toHaveLength(1);
    a.store.leave(true, 'user');
  });

  it('参加のあとに前景サービスが失敗したら知らせる（1 回だけ）。抜けたあとは購読を外す', async () => {
    const a = makeClient('u1');
    await a.store.join();
    await flush();
    a.toast.mockClear();
    a.failService();
    a.failService();
    expect(a.toast.mock.calls.filter((c) => String(c[0]).includes('バックグラウンド'))).toHaveLength(1);
    a.store.leave(true, 'user');
    expect(a.serviceOff).toHaveBeenCalled();
  });

  it('外されて入り直したあと、一覧に戻らなければ 3 秒で閉じて理由を知らせる', async () => {
    vi.useFakeTimers();
    try {
      const a = makeClient('u1');
      const realHandle = server.handle.bind(server);
      await a.store.join();
      await vi.advanceTimersByTimeAsync(10);
      server.handle = (c, ev) => (ev.type === 'call.join' ? undefined : realHandle(c, ev));
      a.store.onServerEvent({ type: 'call.state', members: [] } as never);
      await vi.advanceTimersByTimeAsync(3100);
      expect(a.store.joined).toBe(false);
      expect(a.toast).toHaveBeenCalledWith(expect.stringContaining('通話に入れませんでした'), 'error');
      server.handle = realHandle;
    } finally {
      vi.useRealTimers();
    }
  });

  it('AudioContext が running のまま時計が進まないと、音の経路を作り直す（参加者はそのまま）', async () => {
    const a = makeClient('u1');
    await a.store.join();
    await flush();
    const priv = a.store as unknown as {
      ctx: FakeAudioContext;
      stallSince: number | null;
      stallCtxTime: number;
      lastRebuildAt: number;
      joined: boolean;
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = priv.ctx;
    // 時計が 3 秒以上止まっていた、と見せかける
    priv.stallCtxTime = before.currentTime;
    priv.stallSince = performance.now() - 4000;
    priv.lastRebuildAt = Number.NEGATIVE_INFINITY;
    a.store.tick();
    expect(priv.ctx).not.toBe(before);
    expect(priv.joined).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('[call] 音の経路を作り直します'))).toBe(true);

    // 作り直しの直後は、また止まっていても 10 秒は作り直さない（間隔）
    const after = priv.ctx;
    priv.stallCtxTime = after.currentTime;
    priv.stallSince = performance.now() - 4000;
    a.store.tick();
    expect(priv.ctx).toBe(after);
    warn.mockRestore();
  });

  it('時計が進んでいれば、作り直さない', async () => {
    const a = makeClient('u1');
    await a.store.join();
    await flush();
    const priv = a.store as unknown as { ctx: FakeAudioContext; stallSince: number | null };
    const before = priv.ctx;
    priv.stallSince = performance.now() - 4000;
    before.currentTime += 1;
    a.store.tick();
    expect(priv.ctx).toBe(before);
  });

  it('参加中は 5 秒ごとに call.alive を送る。一覧に載るまでは送らない', async () => {
    const a = makeClient('u1');
    const priv = a.store as unknown as { aliveAt: number; listed: boolean };
    await a.store.join();
    await flush();
    const count = () => a.sent.filter((e) => e.type === 'call.alive').length;
    expect(count()).toBe(0);
    // 5 秒たったことにして、tick で送る
    priv.aliveAt = performance.now() - 5000;
    a.store.tick();
    expect(count()).toBe(1);
    // すぐにもう一度は送らない
    a.store.tick();
    expect(count()).toBe(1);

    // 一覧から外れている（載っていない）あいだは送らない
    priv.listed = false;
    priv.aliveAt = performance.now() - 5000;
    a.store.tick();
    expect(count()).toBe(1);
  });

  it('参加の前に join が拒否された（error）と、通話を閉じて理由を toast する', async () => {
    const a = makeClient('u1');
    const realHandle = server.handle.bind(server);
    // サーバーが join を拒否する（error を返す）
    server.handle = (c, ev) => {
      if (ev.type !== 'call.join') return realHandle(c, ev);
      c.sent.push(ev);
      c.store.onServerEvent({ type: 'error', code: 'invalid_status', message: 'デバイスの種類が長すぎます' } as never);
    };
    await a.store.join();
    await flush();
    expect(a.store.joined).toBe(false);
    expect(a.toast).toHaveBeenCalledWith('通話に入れませんでした（デバイスの種類が長すぎます）', 'error');
    server.handle = realHandle;
  });

  it('入る（join）を送って、サーバーの一覧に自分が無いままだと、console.warn に残す（診断）', async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const a = makeClient('u1');
      // 一覧に自分を入れないサーバー（join を黙って落とす）
      const realHandle = server.handle.bind(server);
      server.handle = (c, ev) => (ev.type === 'call.join' ? undefined : realHandle(c, ev));
      await a.store.join();
      await vi.advanceTimersByTimeAsync(3100);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('サーバーの参加者一覧に自分がいません'));
      server.handle = realHandle;
    } finally {
      vi.useRealTimers();
    }
  });

  it('入れたときは、一覧に自分があるので警告しない', async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const a = makeClient('u1');
      await a.store.join();
      await vi.advanceTimersByTimeAsync(3100);
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('サーバーの参加者一覧に自分がいません'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('peer_in_use で一度だけ新しい peer ID で入り直す（入れないまま操作を重ねない）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = makeClient('u1');
    const b = makeClient('u2');
    await connect(a, b);
    a.store.onServerEvent({ type: 'error', code: 'peer_in_use', message: 'その接続 ID はすでに使われています' } as never);
    await flush();
    const joins = a.sent.filter((e) => e.type === 'call.join');
    expect(joins.length).toBe(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('code=peer_in_use'));
    // 2 回目も同じ error なら、それ以上は入り直さない
    a.store.onServerEvent({ type: 'error', code: 'peer_in_use', message: 'x' } as never);
    await flush();
    expect(a.sent.filter((e) => e.type === 'call.join').length).toBe(2);
  });

  it('チャットの接続が切れると通話の取りこぼしを知らせ、戻ると入り直して知らせる（参加中だけ）', async () => {
    const a = makeClient('u1');
    a.store.onLink(false);
    expect(a.store.linkDown).toBe(false);
    expect(a.toast).not.toHaveBeenCalled();

    await a.store.join();
    a.store.onLink(false);
    expect(a.store.linkDown).toBe(true);
    expect(a.toast).toHaveBeenCalledTimes(1);
    a.store.onLink(false);
    expect(a.toast).toHaveBeenCalledTimes(1);

    a.store.onLink(true);
    expect(a.store.linkDown).toBe(false);
    expect(a.toast).toHaveBeenCalledTimes(2);

    a.store.leave();
    expect(a.store.linkDown).toBe(false);
  });

  it('スピーカーミュートの通知のボタンの文言が変わり、通知のボタンから操作できる', async () => {
    const a = makeClient('u1');
    const b = makeClient('u2');
    await connect(a, b);
    const first = a.hold.mock.calls[0]![0] as { actions: { id: string }[]; onAction: (id: string) => void };
    expect(first.actions.map((x) => x.id)).toEqual(['mute', 'deafen', 'hangup']);
    first.onAction('deafen');
    expect(a.store.deafened).toBe(true);
    a.store.toggleDeafen();
    const handle = await a.hold.mock.results[0]!.value;
    first.onAction('mute');
    expect(handle.update).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('ミュート中') }));
    first.onAction('hangup');
    expect(a.store.joined).toBe(false);
  });

  it('相手を自分の側だけで消音できる（相手には影響しない）', async () => {
    const a = makeClient('u1');
    const b = makeClient('u2');
    await connect(a, b);
    const other = a.store.participants[1]!;
    a.store.toggleLocalMute(other.peer);
    expect(a.store.participants[1]).toMatchObject({ localMuted: true });
    expect(b.store.participants.find((p) => p.userId === 'u1')).toMatchObject({ muted: false, localMuted: false });
    a.store.toggleLocalMute(other.peer);
    expect(a.store.participants[1]).toMatchObject({ localMuted: false });
  });
});

describe('kick', () => {
  it('確認のあとで外すと、外された人の通話は切れてトーストで知らせる', async () => {
    const a = makeClient('u1');
    const b = makeClient('u2');
    await connect(a, b);
    const target = a.store.participants.find((p) => p.userId === 'u2')!;
    await a.store.kick(target.peer);
    expect(a.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining('Bob'), danger: true }));
    await flush();
    expect(b.store.joined).toBe(false);
    expect(b.toast).toHaveBeenCalledWith('Aliceさんに通話から外されました', 'info');
    expect(a.store.joined).toBe(true);
    expect(a.store.participants.map((p) => p.userId)).toEqual(['u1']);
  });

  it('確認で取り消せば何も起きない。参加していない人は外せない', async () => {
    const a = makeClient('u1');
    const b = makeClient('u2');
    await connect(a, b);
    a.confirm.mockResolvedValueOnce(false);
    await a.store.kick(a.store.participants[1]!.peer);
    await flush();
    expect(b.store.joined).toBe(true);
    expect(a.sent.some((e) => e.type === 'call.kick')).toBe(false);
    b.store.leave();
    const c = makeClient('u3');
    await c.store.kick('whoever');
    expect(c.confirm).not.toHaveBeenCalled();
  });
});

describe('拡張 API', () => {
  it('参加していないときは emit できない。audio は本体が使う', async () => {
    const a = makeClient('u1');
    expect(() => a.store.emit('x', 1)).toThrow('参加していません');
    await a.store.join();
    expect(() => a.store.emit('audio', 1)).toThrow(/本体/);
    expect(() => a.store.emit('', 1)).toThrow();
  });

  it('emit したデータが、参加者の onEvent に送り主付きで届く（自分には届かない）。外すと来ない', async () => {
    const a = makeClient('u1');
    const b = makeClient('u2');
    await connect(a, b);
    const got = vi.fn();
    const own = vi.fn();
    const off = b.store.onEvent('frame', got);
    a.store.onEvent('frame', own);
    a.store.emit('frame', { n: 1 });
    a.store.emit('other', { n: 2 });
    await flush();
    expect(got).toHaveBeenCalledTimes(1);
    expect(got).toHaveBeenCalledWith({ peer: a.store.myPeer, userId: 'u1', payload: { n: 1 } });
    expect(own).not.toHaveBeenCalled();
    off();
    a.store.emit('frame', { n: 3 });
    await flush();
    expect(got).toHaveBeenCalledTimes(1);
  });

  it('通話のバーのボタンを足して、更新して、外せる', () => {
    const a = makeClient('u1');
    const btn = a.store.addBarButton({ icon: 'monitor-up', label: '画面共有', onClick: () => {} });
    expect(a.store.barButtons).toHaveLength(1);
    btn.update({ active: true });
    expect(a.store.barButtons[0]).toMatchObject({ label: '画面共有', active: true });
    btn.remove();
    expect(a.store.barButtons).toHaveLength(0);
  });

  it('view のボタンは通話の全画面だけに出し、既存のボタンは上部にも出す', () => {
    const a = makeClient('u1');
    const both = a.store.addBarButton({ icon: 'test', label: '両方', onClick: () => {} });
    const view = a.store.addBarButton({ icon: 'monitor-up', label: '画面共有', location: 'view', onClick: () => {} });
    expect(a.store.barButtons.map((b) => b.label)).toEqual(['両方', '画面共有']);
    expect(a.store.topBarButtons.map((b) => b.label)).toEqual(['両方']);
    view.update({ location: 'both' });
    expect(a.store.topBarButtons).toHaveLength(2);
    both.remove();
    view.remove();
    expect(a.store.topBarButtons).toHaveLength(0);
  });

  it('通話の画面の領域（addPanel）を足して、出し入れ・外せる。文書に入った・外れたことが届く', () => {
    const a = makeClient('u1');
    const api = createCallApi(a.store, (id) => ({ id, login_name: id, display_name: id, avatar_url: null }));
    const p2 = api.addPanel({ label: '後', order: 5 });
    const p1 = api.addPanel({ label: '先' });
    expect(a.store.panels.map((p) => p.label)).toEqual(['先', '後']);
    expect(a.store.panels.every((p) => !p.visible)).toBe(true);
    p1.setVisible(true);
    expect(p1.visible).toBe(true);
    expect(a.store.panels[0]).toMatchObject({ label: '先', visible: true, el: p1.el });
    const seen = vi.fn();
    p1.onMount(seen);
    a.store.panelMounted(a.store.panels[0].id, true);
    expect(p1.mounted).toBe(true);
    expect(seen).toHaveBeenLastCalledWith(true);
    a.store.panelMounted(a.store.panels[0].id, false);
    expect(seen).toHaveBeenLastCalledWith(false);
    p1.remove();
    p2.remove();
    expect(a.store.panels).toHaveLength(0);
    // 送信待ちは、渡されていなければ 0
    expect(api.bufferedAmount).toBe(0);
  });

  it('状態の変化を onChange で受け取れて、外すと来なくなる', async () => {
    const a = makeClient('u1');
    const cb = vi.fn();
    const off = a.store.onChange(cb);
    await a.store.join();
    expect(cb).toHaveBeenCalled();
    cb.mockClear();
    off();
    a.store.toggleMute();
    expect(cb).not.toHaveBeenCalled();
  });

  it('disnans.call は参加者を User 付きで返し、データの送受信ができ、例外を出すコールバックがあっても止まらない', async () => {
    const a = makeClient('u1');
    const b = makeClient('u2');
    const toUser = (id: string) => ({ id, login_name: id, display_name: names[id] ?? '?', avatar_url: null });
    const apiA = createCallApi(a.store, toUser);
    const apiB = createCallApi(b.store, toUser);
    expect(apiA.joined).toBe(false);
    await connect(a, b);
    expect(apiA.joined).toBe(true);
    expect(apiA.participants.map((p) => [p.user.display_name, p.self])).toEqual([
      ['Alice', true],
      ['Bob', false],
    ]);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen = vi.fn();
    apiB.onEvent('x', () => {
      throw new Error('boom');
    });
    apiB.onEvent('x', seen);
    apiA.emit('x', 'hello');
    await flush();
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ user: expect.objectContaining({ display_name: 'Alice' }), payload: 'hello' }));
    expect(err).toHaveBeenCalled();
  });
});

describe('音声の診断（要約・即時・マイクの状態・送受信の数）', () => {
  const diagOf = (c: Client) => (c.store as unknown as { diag: { get(k: string): number } }).diag;
  const micOf = (c: Client) => (c.store as unknown as { localStream: FakeStream }).localStream.getAudioTracks()[0];

  it('相手がいなくても、5 秒ごとの要約を出す（相手の数と取り込みの有無つき）', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const a = makeClient('u1');
    await a.store.join();
    now.mockReturnValue(1000 + 5000);
    a.store.tick();
    const lines = info.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[call] 診断 要約'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('相手=0');
    expect(lines[0]).toContain('取込=off');
    expect(lines[0]).toContain('前回から=5');
    now.mockRestore();
    info.mockRestore();
  });

  it('マイクの状態変化は 1 回ずつ記録し、抜けたあとは外す（参加と退出を繰り返しても残らない）', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const a = makeClient('u1');
    for (let i = 0; i < 2; i++) {
      await a.store.join();
      const track = micOf(a);
      track.fire('mute');
      track.fire('unmute');
      const lines = info.mock.calls.map((c) => String(c[0]));
      expect(lines.filter((l) => l.startsWith('[call] マイク: mute'))).toHaveLength(i + 1);
      expect(track.listenerCount()).toBe(3);
      a.store.leave();
      expect(track.listenerCount()).toBe(0);
    }
    info.mockRestore();
  });

  it('マイクが途中で止まった（ended）ときは警告と通知を出す', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = makeClient('u1');
    await a.store.join();
    micOf(a).fire('ended');
    expect(warn).toHaveBeenCalledWith('[call] マイクが止まりました');
    expect(a.toast).toHaveBeenCalledWith('マイクが止まりました。通話し直してください', 'error');
    a.store.leave();
    warn.mockRestore();
  });

  it('背景・表示に切り替わると、その時点の 1 行を出す', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const a = makeClient('u1');
    await a.store.join();
    let state = 'hidden';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
    state = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    const lines = info.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.startsWith('[call] 診断 背景:'))).toBe(true);
    expect(lines.some((l) => l.startsWith('[call] 診断 表示:'))).toBe(true);
    delete (document as unknown as Record<string, unknown>).visibilityState;
    a.store.leave();
    info.mockRestore();
  });

  it('退出の行は、状態をクリアする前に出す（参加中の累計が見える）', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const a = makeClient('u1');
    await a.store.join();
    a.store.leave(true, 'user');
    const lines = info.mock.calls.map((c) => String(c[0]));
    const exit = lines.findIndex((l) => l.startsWith('[call] 診断 退出: user'));
    const left = lines.findIndex((l) => l.startsWith('[call] 通話から抜けます'));
    expect(exit).toBeGreaterThan(-1);
    expect(exit).toBeLessThan(left);
    info.mockRestore();
  });

  it('送った数と、受けて鳴らした数・捨てた理由を数える', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const a = makeClient('u1');
    const b = makeClient('u2');
    await a.store.join();
    await b.store.join();
    await flush();
    expect(speak(a).length).toBeGreaterThan(0);
    await flush();
    expect(diagOf(a).get('sendTry')).toBeGreaterThan(0);
    expect(diagOf(a).get('capCb')).toBeGreaterThan(0);
    expect(diagOf(b).get('recv')).toBeGreaterThan(0);
    expect(diagOf(b).get('play')).toBeGreaterThan(0);
    // 聞かない（deafen）のあいだに届いた音は、捨てた理由（muted）として数える
    b.store.toggleDeafen();
    const before = diagOf(b).get('recvDrop.muted');
    speak(a);
    await flush();
    expect(diagOf(b).get('recvDrop.muted')).toBeGreaterThan(before);
    a.store.leave();
    b.store.leave();
    info.mockRestore();
  });
});

describe('診断用 API が例外を投げても、参加と退出は通る', () => {
  it('getOutputTimestamp が throw しても、参加・tick・退出が成功し、出力時刻は - になる', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    class Throwing extends FakeAudioContext {
      getOutputTimestamp() {
        throw new Error('診断 API が使えない');
      }
    }
    vi.stubGlobal('AudioContext', Throwing);
    const a = makeClient('u1');
    await a.store.join();
    expect(a.store.joined).toBe(true);
    now.mockReturnValue(1000 + 5000);
    a.store.tick();
    a.store.leave();
    expect(a.store.joined).toBe(false);
    const lines = info.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.startsWith('[call] 診断 参加:') && l.includes('出力時刻=-'))).toBe(true);
    expect(lines.some((l) => l.startsWith('[call] 診断 要約:') && l.includes('出力時刻=-'))).toBe(true);
    expect(lines.some((l) => l.startsWith('[call] 診断 退出: user'))).toBe(true);
    now.mockRestore();
    info.mockRestore();
  });
});
