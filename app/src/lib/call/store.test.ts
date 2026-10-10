// @vitest-environment jsdom
// 通話のストアを2〜3人分作り、サーバーの代わりの中継（参加者の管理・call.emit・kick）でつないで、参加・接続・kick・再ネゴシエーションを確かめる
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallMember } from '../protocol/CallMember';
import type { ClientEvent } from '../protocol/ClientEvent';
import type { ServerEvent } from '../protocol/ServerEvent';
import { createCallApi } from './api';
import { CallSettings } from './settings.svelte';
import { CallStore, type CallDeps } from './store.svelte';

// ---- 偽物 ----

let seq = 0;

class FakeTrack {
  id = `t${++seq}`;
  enabled = true;
  listeners = new Map<string, Set<() => void>>();
  constructor(public kind: 'audio' | 'video') {}
  stop() {}
  addEventListener(type: string, cb: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }
  fire(type: string) {
    for (const cb of this.listeners.get(type) ?? []) cb();
  }
}

class FakeStream {
  id = `s${++seq}`;
  tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = tracks;
  }
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  addEventListener() {}
}

/** WebRTC の偽物。SDP の代わりに「送っているトラックの一覧」を送り、相手の側でトラックが届いたことにする。negotiationneeded も模す */
class FakePc {
  static all: FakePc[] = [];
  connectionState = 'new';
  signalingState = 'stable';
  remoteDescription: { type: string; sdp: string } | null = null;
  localDescription: { type: string; sdp: string } | null = null;
  onicecandidate: unknown = null;
  ontrack: ((ev: { streams: FakeStream[]; track: FakeTrack }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;
  senders: { track: FakeTrack; stream: FakeStream }[] = [];
  seen = new Map<string, FakeTrack>();
  needsNeg = false;
  closed = false;
  constructor() {
    FakePc.all.push(this);
  }
  addTrack(track: FakeTrack, stream: FakeStream) {
    const s = { track, stream };
    this.senders.push(s);
    this.markNeg();
    return s;
  }
  removeTrack(s: { track: FakeTrack; stream: FakeStream }) {
    this.senders = this.senders.filter((x) => x !== s);
    this.markNeg();
  }
  markNeg() {
    this.needsNeg = true;
    queueMicrotask(() => this.fireNeg());
  }
  fireNeg() {
    if (this.closed || !this.needsNeg || this.signalingState !== 'stable') return;
    this.needsNeg = false;
    this.onnegotiationneeded?.();
  }
  describe() {
    return JSON.stringify(this.senders.map((s) => ({ id: s.track.id, kind: s.track.kind, stream: s.stream.id })));
  }
  async createOffer() {
    this.needsNeg = false;
    return { type: 'offer', sdp: this.describe() };
  }
  async createAnswer() {
    this.needsNeg = false;
    return { type: 'answer', sdp: this.describe() };
  }
  async setLocalDescription(d: { type: string; sdp: string }) {
    this.localDescription = d;
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
    if (d.type === 'answer') this.settled();
  }
  async setRemoteDescription(d: { type: string; sdp: string }) {
    this.remoteDescription = d;
    // have-local-offer で offer を受けたら、自分の offer は取り消される（rollback）
    this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
    this.applyRemote(d.sdp);
    if (d.type === 'answer') this.settled();
  }
  async addIceCandidate() {}
  settled() {
    if (this.connectionState !== 'connected') {
      this.connectionState = 'connected';
      this.onconnectionstatechange?.();
    }
    queueMicrotask(() => this.fireNeg());
  }
  applyRemote(sdp: string) {
    const list = JSON.parse(sdp) as { id: string; kind: 'audio' | 'video'; stream: string }[];
    const ids = new Set(list.map((x) => x.id));
    for (const x of list) {
      if (this.seen.has(x.id)) continue;
      const track = new FakeTrack(x.kind);
      this.seen.set(x.id, track);
      const stream = new FakeStream([track]);
      stream.id = x.stream;
      this.ontrack?.({ track, streams: [stream] });
    }
    for (const [id, track] of [...this.seen]) {
      if (ids.has(id)) continue;
      this.seen.delete(id);
      track.fire('ended');
    }
  }
  close() {
    this.closed = true;
  }
}

class FakeAudioContext {
  state = 'running';
  sampleRate = 48000;
  currentTime = 0;
  destination = {};
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

class FakeAudio {
  autoplay = false;
  muted = false;
  volume = 1;
  srcObject: unknown = null;
  play() {
    return Promise.resolve();
  }
}

// ---- サーバーの代わり ----

type Client = { store: CallStore; userId: string; conn: number; toast: ReturnType<typeof vi.fn>; confirm: ReturnType<typeof vi.fn>; hold: ReturnType<typeof vi.fn>; sent: ClientEvent[]; rtc: boolean };

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
    if (this.members.delete(c.conn)) this.broadcastState();
  }
  handle(c: Client, ev: ClientEvent) {
    c.sent.push(ev);
    switch (ev.type) {
      case 'call.join':
        this.members.set(c.conn, { peer: ev.peer, user_id: c.userId, status: ev.status });
        this.broadcastState();
        break;
      case 'call.leave':
        this.drop(c);
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

function makeClient(userId: string, opts: { rtc?: boolean; device?: string } = {}): Client {
  const rtc = opts.rtc ?? true;
  const toast = vi.fn();
  const confirm = vi.fn(async () => true);
  const hold = vi.fn(async () => Object.assign(() => {}, { update: vi.fn() }));
  const client = { userId, conn: server.clients.length + 1, toast, confirm, hold, sent: [] as ClientEvent[], rtc } as Client;
  const deps: CallDeps = {
    send: (ev) => server.handle(client, ev),
    meId: () => userId,
    nameOf: (id) => names[id] ?? '不明なユーザー',
    toast,
    confirm,
    hold,
    audio: {
      listOutputs: async () => [
        { id: 'earpiece', label: '受話口', kind: 'earpiece', selected: false },
        { id: 'speaker', label: 'スピーカー', kind: 'speaker', selected: true },
      ],
      setOutput: async () => true,
      listInputs: async () => [],
      attach: () => () => {},
    },
    settings: new CallSettings(),
    deviceKind: () => opts.device ?? 'laptop',
    openSettings: () => {},
    hasRtc: () => rtc,
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
  FakePc.all = [];
  server = new FakeServer();
  localStorage.clear();
  vi.stubGlobal('RTCPeerConnection', FakePc);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('MediaStream', FakeStream);
  vi.stubGlobal('Worker', class { onmessage = null; terminate() {} });
  vi.stubGlobal('Audio', FakeAudio);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => new FakeStream([new FakeTrack('audio')]) },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 2人が参加してつながるまで進める */
async function connect(a: Client, b: Client) {
  await a.store.join();
  await b.store.join();
  await flush();
}

describe('参加と接続', () => {
  it('参加すると参加していない人にも見え、片方だけが offer を出して音声がつながる。抜けると消えて接続が閉じる', async () => {
    const a = makeClient('u1');
    const b = makeClient('u2');
    expect(a.store.visible).toBe(false);

    await a.store.join();
    await flush();
    expect(a.store.joined).toBe(true);
    expect(a.hold).toHaveBeenCalledWith(expect.objectContaining({ microphone: true }));
    // 参加していない B にも、A がいることが見える
    expect(b.store.visible).toBe(true);
    expect(b.store.joined).toBe(false);
    expect(b.store.participants.map((p) => p.userId)).toEqual(['u1']);

    await b.store.join();
    await flush();
    expect(FakePc.all).toHaveLength(2); // 双方向に作らず、1本ずつ（それぞれの端末に1つ）
    expect(a.store.participants).toHaveLength(2);
    expect(a.store.participants[0]).toMatchObject({ self: true, userId: 'u1' });
    expect(a.store.participants[1]).toMatchObject({ self: false, userId: 'u2', connected: true });
    expect(b.store.participants[1]).toMatchObject({ userId: 'u1', connected: true });

    b.store.leave();
    await flush();
    expect(b.store.joined).toBe(false);
    expect(a.store.participants.map((p) => p.userId)).toEqual(['u1']);
    expect(FakePc.all.every((p) => p.closed)).toBe(true);
    // 最後の1人が抜ければバーも消える
    a.store.leave();
    await flush();
    expect(a.store.visible).toBe(false);
  });

  it('マイクを使えない環境ではトーストを出して参加しない', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    const a = makeClient('u1');
    await a.store.join();
    expect(a.store.joined).toBe(false);
    expect(a.toast).toHaveBeenCalledWith(expect.stringContaining('マイク'), 'error');
    expect(a.sent).toHaveLength(0);
  });

  it('ミュート・スピーカーミュート・端末の種類は参加者に共有される', async () => {
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
    const join = a.sent.find((e) => e.type === 'call.join');
    expect(join).toMatchObject({ status: { muted: true } });
  });

  it('つなぎ直す（hello）と入り直し、WebRTC の接続もやり直す', async () => {
    const a = makeClient('u1');
    const b = makeClient('u2');
    await connect(a, b);
    const peerA = a.store.myPeer;
    // A の接続が切れて、サーバーから外れた
    server.drop(a);
    await flush();
    expect(b.store.participants.map((p) => p.userId)).toEqual(['u2']);
    // B の側の接続は閉じた。切れている A はまだ知らない
    expect(FakePc.all.filter((p) => !p.closed)).toHaveLength(1);
    const stale = FakePc.all.find((p) => !p.closed)!;
    a.store.onServerEvent({ type: 'hello', me: { id: 'u1' } as never, users: [] });
    await flush();
    expect(a.store.myPeer).toBe(peerA);
    expect(stale.closed).toBe(true);
    expect(b.store.participants.map((p) => p.userId).sort()).toEqual(['u1', 'u2']);
  });

  it('スピーカーミュートは相手の音を消し、通知のボタンの文言も変わる。通知のボタンから操作できる', async () => {
    const a = makeClient('u1');
    const b = makeClient('u2');
    await connect(a, b);
    const first = a.hold.mock.calls[0]![0] as { actions: { id: string }[]; onAction: (id: string) => void };
    expect(first.actions.map((x) => x.id)).toEqual(['mute', 'deafen', 'hangup']);
    const entries = (a.store as unknown as { entries: Map<string, { audio: { muted: boolean } | null }> }).entries;
    const audioEl = [...entries.values()][0]!.audio!;
    expect(audioEl.muted).toBe(false);
    first.onAction('deafen');
    expect(a.store.deafened).toBe(true);
    expect(audioEl.muted).toBe(true);
    a.store.toggleDeafen();
    expect(audioEl.muted).toBe(false);
    // 人数やミュートが変わると通知を差し替える
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
  it('確認のあとで外すと、外された人の通話は切れてトーストで知らせる。相手の接続も閉じる', async () => {
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
    expect(FakePc.all.every((p) => p.closed)).toBe(true);
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

describe('リレー（WebRTC を使えない環境）', () => {
  it('WebRTC なしでも参加でき、rtc:false を伝え、接続は作らずつながったことにする', async () => {
    const a = makeClient('u1', { rtc: false });
    const b = makeClient('u2');
    await connect(a, b);
    a.store.tick();
    await flush();
    expect(FakePc.all).toHaveLength(0);
    expect(a.sent.find((e) => e.type === 'call.join')).toMatchObject({ status: { rtc: false } });
    expect(a.store.canVideo).toBe(false);
    expect(b.store.participants.find((p) => p.userId === 'u1')).toMatchObject({ canVideo: false });
    expect(a.store.participants[1]).toMatchObject({ canVideo: true, connected: true });
    // 映像のトラックは足せない
    expect(() => a.store.addTrack(new FakeTrack('video') as unknown as MediaStreamTrack)).toThrow(/WebRTC/);
  });
});

describe('拡張 API', () => {
  it('参加していないときは addTrack できない', () => {
    const a = makeClient('u1');
    expect(() => a.store.addTrack(new FakeTrack('video') as unknown as MediaStreamTrack)).toThrow('参加していません');
  });

  it('トラックを足すと再ネゴシエーションで相手に届き、外すと終わりが伝わる', async () => {
    const a = makeClient('u1');
    const b = makeClient('u2');
    await connect(a, b);
    const got = vi.fn();
    const ended = vi.fn();
    b.store.onTrack(got);
    b.store.onTrackEnd(ended);
    const video = new FakeTrack('video') as unknown as MediaStreamTrack;
    const off = a.store.addTrack(video);
    await flush();
    expect(got).toHaveBeenCalledTimes(1);
    expect(got.mock.calls[0]![0]).toMatchObject({ userId: 'u1', track: { kind: 'video' } });
    expect(b.store.remoteTracks).toHaveLength(1);
    // 声（最初の音声）はトラックとして渡さない
    expect(got.mock.calls.every((c) => c[0].track.kind === 'video')).toBe(true);
    off();
    await flush();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(b.store.remoteTracks).toHaveLength(0);
  });

  it('両方が同時にトラックを足してもぶつからずに両方に届く', async () => {
    const a = makeClient('u1');
    const b = makeClient('u2');
    await connect(a, b);
    const gotA = vi.fn();
    const gotB = vi.fn();
    a.store.onTrack(gotA);
    b.store.onTrack(gotB);
    a.store.addTrack(new FakeTrack('video') as unknown as MediaStreamTrack);
    b.store.addTrack(new FakeTrack('video') as unknown as MediaStreamTrack);
    await flush();
    expect(gotA).toHaveBeenCalledTimes(1);
    expect(gotB).toHaveBeenCalledTimes(1);
  });

  it('あとから参加した人にも、足してあるトラックが届く。抜けると足したトラックは外れる', async () => {
    const a = makeClient('u1');
    const b = makeClient('u2');
    await a.store.join();
    await flush();
    a.store.addTrack(new FakeTrack('video') as unknown as MediaStreamTrack);
    const got = vi.fn();
    b.store.onTrack(got);
    await b.store.join();
    await flush();
    expect(got).toHaveBeenCalledTimes(1);
    a.store.leave();
    expect((a.store as unknown as { extraTracks: unknown[] }).extraTracks).toHaveLength(0);
  });

  it('相手が抜けると届いていたトラックも終わる', async () => {
    const a = makeClient('u1');
    const b = makeClient('u2');
    await connect(a, b);
    const ended = vi.fn();
    b.store.onTrackEnd(ended);
    a.store.addTrack(new FakeTrack('video') as unknown as MediaStreamTrack);
    await flush();
    a.store.leave();
    await flush();
    expect(ended).toHaveBeenCalledTimes(1);
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

  it('disnans.call は参加者を User 付きで返し、例外を出すコールバックがあっても止まらない', async () => {
    const a = makeClient('u1');
    const b = makeClient('u2');
    const toUser = (id: string) => ({ id, login_name: id, display_name: names[id] ?? '?', avatar_url: null });
    const api = createCallApi(a.store, toUser);
    expect(api.joined).toBe(false);
    await connect(a, b);
    expect(api.joined).toBe(true);
    expect(api.canVideo).toBe(true);
    expect(api.participants.map((p) => [p.user.display_name, p.self])).toEqual([
      ['Alice', true],
      ['Bob', false],
    ]);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen = vi.fn();
    api.onTrack(() => {
      throw new Error('boom');
    });
    api.onTrack(seen);
    b.store.addTrack(new FakeTrack('video') as unknown as MediaStreamTrack);
    await flush();
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ user: expect.objectContaining({ display_name: 'Bob' }) }));
    expect(err).toHaveBeenCalled();
    expect(api.remoteTracks).toHaveLength(1);
  });
});
