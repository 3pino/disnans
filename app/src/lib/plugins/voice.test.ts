// @vitest-environment jsdom
// examples/voice を2人分読み込み、本体の broadcast を模した中継でつないで、在室とシグナリングが動くか確かめる
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginBase, PluginRuntime } from './runtime';
import { VersionConflictError } from './sessions';
import { createUi } from './ui';
import { registerIcon, setLucideForTest } from '../icons.svelte';
import { describeDevices } from './audio';
import { API_VERSION, type HostCommand, type HostServices, type PluginClass } from './types';
import type { ClientEvent } from '../protocol/ClientEvent';

(globalThis as unknown as { disnans: Disnans.Host }).disnans = {
  apiVersion: API_VERSION,
  Plugin: PluginBase,
  ui: createUi({ toast: () => {}, confirm: async () => true }),
  VersionConflictError,
  audio: {
    listOutputs: async () => [
      { id: 'earpiece', label: '受話口', kind: 'earpiece', selected: false },
      { id: 'speaker', label: 'スピーカー', kind: 'speaker', selected: true },
    ],
    setOutput: async () => true,
    listInputs: async () => [],
    attach: () => () => {},
  },
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
  state = 'running';
  createGain() {
    return { gain: { value: 1 }, connect: () => {} };
  }
  createMediaStreamDestination() {
    return { stream: { getTracks: () => [{ enabled: true }], getAudioTracks: () => [{ enabled: true }] } };
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
  const hold = vi.fn(async () => Object.assign(() => {}, { update: () => {} }));
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
  const r = new PluginRuntime({ id: 'voice', name: 'ボイスチャット', version: '0.1.0', description: '', author: '', minApiVersion: 5 }, services);
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

/** openSettings の有無を切り替えるため、プロトタイプの元の定義を覚えておく */
const protoSettings = Object.getOwnPropertyDescriptor(PluginBase.prototype, 'openSettings');

beforeEach(() => {
  clients.length = 0;
  FakePc.all = [];
  // 既定は「openSettings のないホスト」。必要なテストだけ足す
  delete (PluginBase.prototype as unknown as Record<string, unknown>).openSettings;
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
      ['Puzzle', 'Phone', 'PhoneOff', 'Mic', 'MicOff', 'VolumeX', 'Settings'].map((k) => [k, [['path', { d: 'M1 1' }]]]),
    ) as never,
  );
});
afterEach(() => {
  delete (PluginBase.prototype as unknown as Record<string, unknown>).openSettings;
  if (protoSettings) Object.defineProperty(PluginBase.prototype, 'openSettings', protoSettings);
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

  it('スピーカーミュートは相手の音を消し、通知のボタンの文言も変わる。出力先の選択は保存される', async () => {
    const a = makeClient('u1');
    const b = makeClient('u2');
    await start(a);
    await start(b);
    await a.commands.get('voice:join')!.run({ args: '', threadId: null, via: 'palette' });
    await b.commands.get('voice:join')!.run({ args: '', threadId: null, via: 'palette' });
    plugin(a).tick();
    plugin(b).tick();
    await flush();
    await flush();
    const first = a.hold.mock.calls[0][0] as { actions: { id: string; title: string }[]; onAction: (id: string) => void };
    expect(first.actions.map((x) => x.id)).toEqual(['mute', 'deafen', 'hangup']);
    const p = plugin(a) as unknown as { deafened: boolean; entries: Map<string, { audio: { muted: boolean; volume: number } | null }> };
    const audioEl = [...p.entries.values()][0]!.audio!;
    expect(audioEl.muted).toBe(false);
    first.onAction('deafen');
    expect(p.deafened).toBe(true);
    expect(audioEl.muted).toBe(true);
    expect(a.bar.querySelector('.voice-active')).not.toBeNull();
    a.commands.get('voice:deafen')!.run({ args: '', threadId: null, via: 'palette' });
    expect(p.deafened).toBe(false);
    expect(audioEl.muted).toBe(false);
    // 出力先の選択はステータス欄には出さない（設定画面で選ぶ）
    expect(a.bar.querySelector('select')).toBeNull();
  });

  it('openSettings のないホストでは、設定ボタンも /vc-settings も出ない', async () => {
    const a = makeClient('u1');
    await start(a);
    expect(a.commands.has('voice:settings')).toBe(false);
    await a.commands.get('voice:join')!.run({ args: '', threadId: null, via: 'palette' });
    expect(a.bar.querySelector('.voice-controls button[aria-label="ボイスチャットの設定"]')).toBeNull();
    // 退出ボタンは右端（最後）に、危険色のクラス付きで置く
    const buttons = [...a.bar.querySelectorAll('.voice-controls button')];
    expect(buttons.at(-1)!.classList.contains('voice-leave')).toBe(true);
  });

  it('openSettings のあるホストでは、設定ボタンと /vc-settings でこのプラグインの設定を開く', async () => {
    const openSettings = vi.fn();
    Object.defineProperty(PluginBase.prototype, 'openSettings', { value: openSettings, configurable: true, writable: true });
    const a = makeClient('u1');
    await start(a);
    expect(a.commands.get('voice:settings')).toMatchObject({ name: 'ボイスチャットの設定を開く', slash: 'vc-settings' });
    await a.commands.get('voice:join')!.run({ args: '', threadId: null, via: 'palette' });
    const btn = a.bar.querySelector<HTMLButtonElement>('.voice-controls button[aria-label="ボイスチャットの設定"]');
    expect(btn).not.toBeNull();
    btn!.click();
    expect(openSettings).toHaveBeenCalledTimes(1);
    await a.commands.get('voice:settings')!.run({ args: '', threadId: null, via: 'slash' });
    expect(openSettings).toHaveBeenCalledTimes(2);
    // 設定ボタンは退出ボタンより前にある
    const buttons = [...a.bar.querySelectorAll('.voice-controls button')];
    expect(buttons.at(-1)!.classList.contains('voice-leave')).toBe(true);
    expect(buttons.at(-2)).toBe(btn);
  });
});

const pure = () => import('../../../../examples/voice/main.js') as unknown as Promise<{
  clampVolume(v: unknown, max: number, fallback?: number): number;
  Resampler: new (src: number, dst?: number) => { push(f: Float32Array): Float32Array };
  Framer: new (size?: number) => { push(f: Float32Array): Float32Array[] };
  floatToInt16(f: Float32Array): Int16Array;
  int16ToFloat(p: Int16Array): Float32Array;
  pcmToBase64(p: Int16Array): string;
  base64ToPcm(b: unknown): Int16Array | null;
  rms(f: Float32Array): number;
  scheduleFrame(st: { next: number }, now: number, dur: number, lead?: number, max?: number): number | null;
  pickOutput(outs: Disnans.AudioOutput[], saved: { id: string; kind: string; label: string } | null): Disnans.AudioOutput | null;
}>;

describe('音量と出力先の純粋な処理', () => {
  it('clampVolume は範囲に収め、数でなければ既定値', async () => {
    const { clampVolume } = await pure();
    expect(clampVolume(3, 2)).toBe(2);
    expect(clampVolume(-1, 2)).toBe(0);
    expect(clampVolume(0.5, 1)).toBe(0.5);
    expect(clampVolume('x', 2, 1)).toBe(1);
    expect(clampVolume(NaN, 2, 0.7)).toBe(0.7);
  });

  it('pickOutput は ID、なければ同じ種類と名前、なければ同じ種類で探す', async () => {
    const { pickOutput } = await pure();
    const outs = [
      { id: 'speaker', label: 'スピーカー', kind: 'speaker', selected: false },
      { id: 'bluetooth:9', label: 'Bluetooth（X）', kind: 'bluetooth', selected: false },
      { id: 'bluetooth:12', label: 'Bluetooth（Y）', kind: 'bluetooth', selected: false },
    ];
    expect(pickOutput(outs, null)).toBeNull();
    expect(pickOutput(outs, { id: 'speaker', kind: 'speaker', label: 'スピーカー' })?.id).toBe('speaker');
    expect(pickOutput(outs, { id: 'bluetooth:3', kind: 'bluetooth', label: 'Bluetooth（Y）' })?.id).toBe('bluetooth:12');
    expect(pickOutput(outs, { id: 'bluetooth:3', kind: 'bluetooth', label: 'Z' })?.id).toBe('bluetooth:9');
    expect(pickOutput(outs, { id: 'wired:1', kind: 'wired', label: 'イヤホン' })).toBeNull();
    expect(pickOutput(outs, { id: 'abc', kind: 'other', label: 'abc' })).toBeNull();
  });

  it('describeDevices は default を実機器と重ねず、名前のない機器に仮の名前を付ける', () => {
    const dev = (kind: string, deviceId: string, label: string) => ({ kind, deviceId, label }) as MediaDeviceInfo;
    const list = [dev('audiooutput', 'default', '既定'), dev('audiooutput', 'a', 'Speakers'), dev('audiooutput', 'b', ''), dev('audioinput', 'm', 'Mic')];
    expect(describeDevices(list, 'audiooutput', '出力')).toEqual([
      { id: 'a', label: 'Speakers' },
      { id: 'b', label: '出力 2' },
    ]);
    expect(describeDevices([dev('audiooutput', 'default', '')], 'audiooutput', '出力')).toEqual([{ id: 'default', label: '出力' }]);
    expect(describeDevices([], 'audioinput', '入力')).toEqual([]);
  });
});

describe('リレー音声の純粋な処理', () => {
  it('Resampler は 48kHz→16kHz で長さが約 1/3 になり、チャンクを分けても同じ結果', async () => {
    const { Resampler } = await pure();
    const input = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 50));
    const whole = new Resampler(48000).push(input);
    expect(Math.abs(whole.length - 1600)).toBeLessThanOrEqual(1);
    const r = new Resampler(48000);
    const parts = [r.push(input.subarray(0, 1000)), r.push(input.subarray(1000, 3333)), r.push(input.subarray(3333))];
    const joined = Float32Array.from(parts.flatMap((p) => [...p]));
    expect(joined.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) expect(joined[i]).toBeCloseTo(whole[i]!, 5);
  });

  it('Framer は指定の長さずつに分け、余りは次に持ち越す', async () => {
    const { Framer } = await pure();
    const f = new Framer(4);
    expect(f.push(new Float32Array(3))).toHaveLength(0);
    const out = f.push(Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(out).toHaveLength(3);
    expect([...out[0]!]).toEqual([0, 0, 0, 1]);
  });

  it('PCM の変換と base64 は往復できて、壊れた入力は null', async () => {
    const { floatToInt16, int16ToFloat, pcmToBase64, base64ToPcm, rms } = await pure();
    const f = Float32Array.from([0, 0.5, -0.5, 1, -1, 2]);
    const pcm = floatToInt16(f);
    expect(pcm[3]).toBe(32767);
    expect(pcm[4]).toBe(-32768);
    expect(pcm[5]).toBe(32767); // 範囲を超えたら丸める
    const back = int16ToFloat(base64ToPcm(pcmToBase64(pcm))!);
    expect(back[1]).toBeCloseTo(0.5, 3);
    expect(back[2]).toBeCloseTo(-0.5, 3);
    expect(base64ToPcm('!!')).toBeNull();
    expect(base64ToPcm('QQ==')).toBeNull(); // 1バイト
    expect(base64ToPcm(5)).toBeNull();
    expect(base64ToPcm('A'.repeat(9000))).toBeNull();
    expect(rms(new Float32Array(4))).toBe(0);
    expect(rms(Float32Array.from([1, -1]))).toBe(1);
  });

  it('scheduleFrame は最初と空になったときにためてから鳴らし、続きは隙間なく、ためすぎは捨てる', async () => {
    const { scheduleFrame } = await pure();
    const st = { next: 0 };
    expect(scheduleFrame(st, 10, 0.05)).toBeCloseTo(10.12);
    expect(scheduleFrame(st, 10.01, 0.05)).toBeCloseTo(10.17);
    // 空になった（時刻が追いついた）ら、またためる
    expect(scheduleFrame(st, 11, 0.05)).toBeCloseTo(11.12);
    // 先に溜まりすぎたら捨てる
    st.next = 12;
    expect(scheduleFrame(st, 11, 0.05)).toBeNull();
  });
});

describe('WebRTC を使えない環境', () => {
  it('RTCPeerConnection がなくても参加でき、在室の知らせで rtc:false を伝える', async () => {
    vi.stubGlobal('RTCPeerConnection', undefined);
    const a = makeClient('u1');
    const b = makeClient('u2');
    await start(a);
    await start(b);
    await a.commands.get('voice:join')!.run({ args: '', threadId: null, via: 'palette' });
    expect(plugin(a).joined).toBe(true);
    await b.commands.get('voice:join')!.run({ args: '', threadId: null, via: 'palette' });
    plugin(a).tick();
    plugin(b).tick();
    await flush();
    expect(FakePc.all).toHaveLength(0);
    const e = [...plugin(a).entries.values()][0] as unknown as { rtc: boolean; connected: boolean };
    expect(e.rtc).toBe(false);
    expect(e.connected).toBe(true);
  });
});
