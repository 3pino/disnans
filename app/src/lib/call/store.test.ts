// @vitest-environment jsdom
// 通話のストアを2〜3人分作り、サーバーの代わりの中継（参加者の管理・call.emit・kick）でつないで、
// サーバー経由の音声（リレー）・ミュート・kick・再接続・拡張 API を確かめる
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallMember } from '../protocol/CallMember';
import type { ClientEvent } from '../protocol/ClientEvent';
import type { ServerEvent } from '../protocol/ServerEvent';
import { createCallApi } from './api';
import { CallSettings } from './settings.svelte';
import { CallStore, type CallDeps } from './store.svelte';

// マイクの取り出しは本物の AudioContext が要るので、偽物にする（音は store の onCapture に直接渡す）
vi.mock('./capture', () => ({ startCapture: () => ({ stop() {} }) }));

// ---- 偽物 ----

let seq = 0;

class FakeTrack {
  id = `t${++seq}`;
  enabled = true;
  constructor(public kind: 'audio' | 'video') {}
  stop() {}
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
  createBuffer(_ch: number, n: number) {
    return { getChannelData: () => new Float32Array(n) };
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

type Client = { store: CallStore; userId: string; conn: number; toast: ReturnType<typeof vi.fn>; confirm: ReturnType<typeof vi.fn>; hold: ReturnType<typeof vi.fn>; sent: ClientEvent[] };

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

function makeClient(userId: string, opts: { device?: string } = {}): Client {
  const toast = vi.fn();
  const confirm = vi.fn(async () => true);
  const hold = vi.fn(async () => Object.assign(() => {}, { update: vi.fn() }));
  const client = { userId, conn: server.clients.length + 1, toast, confirm, hold, sent: [] as ClientEvent[] } as Client;
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
    expect(a.sent.find((e) => e.type === 'call.join')).toMatchObject({ status: { muted: true } });
  });

  it('つなぎ直す（hello）と同じ peer ID で入り直し、また声が届く', async () => {
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
    expect(a.store.myPeer).toBe(peerA);
    expect(b.store.participants.map((p) => p.userId).sort()).toEqual(['u1', 'u2']);
    speak(a);
    await flush();
    expect(plays(b)).toBeGreaterThan(0);
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
