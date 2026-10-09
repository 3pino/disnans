// @vitest-environment jsdom
// examples/voice を2人分読み込み、本体の broadcast を模した中継でつないで、在室とシグナリングが動くか確かめる
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginBase, PluginRuntime } from './runtime';
import { VersionConflictError } from './sessions';
import { createUi } from './ui';
import { registerIcon, setLucideForTest } from '../icons.svelte';
import { API_VERSION, type HostCommand, type HostServices, type PluginClass } from './types';
import type { ClientEvent } from '../protocol/ClientEvent';

(globalThis as unknown as { disnans: Disnans.Host }).disnans = {
  apiVersion: API_VERSION,
  Plugin: PluginBase,
  ui: createUi({ toast: () => {}, confirm: async () => true }),
  VersionConflictError,
};

const users = [
  { id: 'u1', login_name: 'a', display_name: 'A', avatar_url: null },
  { id: 'u2', login_name: 'b', display_name: 'B', avatar_url: null },
];

/** WebRTC の偽物。answer を受け取ったら（または offer に答えたら）つながったことにする */
class FakePc {
  static all: FakePc[] = [];
  connectionState = 'new';
  signalingState = 'stable';
  remoteDescription: { type: string; sdp: string } | null = null;
  localDescription: { type: string; sdp: string } | null = null;
  onicecandidate: unknown = null;
  ontrack: ((ev: { streams: MediaStream[]; track: unknown }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  tracks = 0;
  closed = false;
  constructor() {
    FakePc.all.push(this);
  }
  addTrack() {
    this.tracks++;
  }
  async createOffer() {
    return { type: 'offer', sdp: 'offer' };
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'answer' };
  }
  async setLocalDescription(d: { type: string; sdp: string }) {
    this.localDescription = d;
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
    if (d.type === 'answer') this.connect();
  }
  async setRemoteDescription(d: { type: string; sdp: string }) {
    this.remoteDescription = d;
    if (d.type === 'answer') this.connect();
  }
  async addIceCandidate() {}
  connect() {
    this.connectionState = 'connected';
    this.onconnectionstatechange?.();
    this.ontrack?.({ streams: [{} as MediaStream], track: {} });
  }
  close() {
    this.closed = true;
  }
}

class FakeAudioContext {
  createAnalyser() {
    return { fftSize: 0, getByteTimeDomainData: (b: Uint8Array) => b.fill(128), connect: () => {} };
  }
  createMediaStreamSource() {
    return { connect: () => {} };
  }
  async resume() {}
  async close() {}
}

type Env = {
  me: (typeof users)[number];
  r: PluginRuntime;
  commands: Map<string, HostCommand>;
  bar: HTMLElement;
  hold: ReturnType<typeof vi.fn>;
};
const clients: Env[] = [];

function makeClient(userId: string): Env {
  const me = users.find((u) => u.id === userId)!;
  const commands = new Map<string, HostCommand>();
  const bar = document.createElement('div');
  const hold = vi.fn(async () => () => {});
  const services = {
    app: { me, users, user: (id: string) => users.find((u) => u.id === id), nameOf: (id: string) => id, isMobile: false, theme: 'light' },
    api: {},
    // broadcast を、ほかのクライアントへの plugin.event として配る
    send: (ev: ClientEvent) => {
      if (ev.type !== 'plugin.emit') return;
      for (const c of clients) if (c.me.id !== me.id) c.r.dispatchBroadcast(ev.name, JSON.parse(JSON.stringify(ev.payload)), me.id);
    },
    registerSlashCommand: () => () => {},
    registerComposerAction: () => () => {},
    registerCommand: (c: HostCommand) => {
      commands.set(c.id, c);
      return () => commands.delete(c.id);
    },
    openPanel: () => {},
    closePanel: () => {},
    toast: () => {},
    storage: { get: () => null, set: () => {} },
    pluginIcon: () => 'puzzle',
    registerIcon,
    registerStatusItem: (_id: string, el: HTMLElement) => {
      bar.append(el);
      return () => el.remove();
    },
    holdBackground: hold,
    changed: () => {},
  } as unknown as HostServices;
  const r = new PluginRuntime({ id: 'voice', name: 'ボイスチャット', version: '0.1.0', description: '', author: '', minApiVersion: 3 }, services);
  const env = { me, r, commands, bar, hold };
  clients.push(env);
  return env;
}

async function start(c: Env) {
  const mod = (await import('../../../../examples/voice/main.js')) as { default: PluginClass };
  await c.r.start(mod.default);
}

const plugin = (c: Env) => c.r.instance as unknown as { tick(): void; entries: Map<string, { connected: boolean; pc: unknown }>; joined: boolean };
const flush = () => new Promise((res) => setTimeout(res, 0));

beforeEach(() => {
  clients.length = 0;
  FakePc.all = [];
  vi.stubGlobal('RTCPeerConnection', FakePc);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('Worker', class { onmessage = null; terminate() {} });
  vi.stubGlobal('Audio', class { autoplay = false; muted = false; srcObject: unknown = null; play() { return Promise.resolve(); } });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }], getAudioTracks: () => [{ enabled: true }] }) },
  });
  setLucideForTest(
    Object.fromEntries(
      ['Puzzle', 'Phone', 'PhoneOff', 'Mic', 'MicOff', 'VolumeX'].map((k) => [k, [['path', { d: 'M1 1' }]]]),
    ) as never,
  );
});
afterEach(() => {
  setLucideForTest(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('examples/voice', () => {
  it('参加すると相手に見え、片方だけが offer を出して音声がつながる。抜けると消える', async () => {
    const a = makeClient('u1');
    const b = makeClient('u2');
    await start(a);
    await start(b);
    expect(a.commands.has('voice:join')).toBe(true);
    expect(a.bar.textContent).toBe('');

    await a.commands.get('voice:join')!.run({ args: '', threadId: null, via: 'palette' });
    expect(plugin(a).joined).toBe(true);
    expect(a.hold).toHaveBeenCalledWith(expect.objectContaining({ microphone: true }));
    // 参加していない B にも、A がいることが見える（参加ボタン付き）
    await flush();
    expect(b.bar.querySelectorAll('.voice-person')).toHaveLength(1);
    expect(b.bar.textContent).toContain('参加');

    await b.commands.get('voice:join')!.run({ args: '', threadId: null, via: 'palette' });
    // B の在室を A が知り、A の返事を B が受け取る。そのあとの tick で offer が出る
    plugin(a).tick();
    plugin(b).tick();
    await flush();
    await flush();
    expect(FakePc.all).toHaveLength(2); // 双方向に作らず、1本だけ
    expect([...plugin(a).entries.values()][0]!.connected).toBe(true);
    expect([...plugin(b).entries.values()][0]!.connected).toBe(true);
    expect(a.bar.querySelectorAll('.voice-person')).toHaveLength(2); // 自分と B
    expect(a.bar.textContent).toContain('通話中');

    // B が抜けると A の表示から消え、接続は閉じる
    await b.commands.get('voice:leave')!.run({ args: '', threadId: null, via: 'palette' });
    expect(plugin(b).joined).toBe(false);
    expect(a.bar.querySelectorAll('.voice-person')).toHaveLength(1);
    expect(FakePc.all.every((p) => p.closed)).toBe(true);
  });

  it('ハートビートが途絶えた人は外れる', async () => {
    const a = makeClient('u1');
    const b = makeClient('u2');
    await start(a);
    await start(b);
    await b.commands.get('voice:join')!.run({ args: '', threadId: null, via: 'palette' });
    expect(a.bar.querySelectorAll('.voice-person')).toHaveLength(1);
    const now = performance.now();
    vi.spyOn(performance, 'now').mockReturnValue(now + 13000);
    plugin(a).tick();
    expect(a.bar.textContent).toBe('');
  });

  it('マイクを使えない環境ではトーストを出して参加しない', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    const a = makeClient('u1');
    await start(a);
    await a.commands.get('voice:join')!.run({ args: '', threadId: null, via: 'palette' });
    expect(plugin(a).joined).toBe(false);
  });
});
