// @vitest-environment jsdom
// Android のネイティブ所有の通話（CallStore の native 経路）。JS がマイク・音・チャットの call.join を持たないことを確かめる
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientEvent } from '../protocol/ClientEvent';
import type { ServerEvent } from '../protocol/ServerEvent';
import { CallSettings, createCallSource } from './settings.svelte';
import { CallStore, type CallDeps } from './store.svelte';
import { FakeNativePort, snap } from './nativeFake';
import { DEFAULT_CALL_SETTINGS } from './pure';

type Harness = {
  store: CallStore;
  port: FakeNativePort;
  send: ReturnType<typeof vi.fn>;
  toast: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
  hold: ReturnType<typeof vi.fn>;
  attach: ReturnType<typeof vi.fn>;
  settings: CallSettings;
};

const names: Record<string, string> = { u1: 'たろう', me: '自分' };
/** いま選ばれている接続先（テストから変える） */
let serverNow = 'http://srv.test';

function make(over: { joinMuted?: boolean; confirmOk?: boolean } = {}): Harness {
  const port = new FakeNativePort();
  const send = vi.fn<(ev: ClientEvent) => void>();
  const toast = vi.fn();
  const confirm = vi.fn(async () => over.confirmOk ?? true);
  const hold = vi.fn(async () => Object.assign(() => {}, { update: () => {} }));
  const attach = vi.fn(() => () => {});
  const settings = new CallSettings(createCallSource({ ...DEFAULT_CALL_SETTINGS, joinMuted: over.joinMuted ?? false }));
  const deps: CallDeps = {
    native: port,
    serverUrl: () => serverNow,
    devUser: () => null,
    send,
    meId: () => 'me',
    nameOf: (id) => names[id] ?? '不明',
    toast,
    confirm,
    hold,
    audio: {
      listOutputs: async () => [],
      setOutput: async () => true,
      listInputs: async () => [],
      attach,
    },
    settings,
    deviceKind: () => 'laptop',
    openSettings: () => {},
    now: () => performance.now(),
  };
  return { store: new CallStore(deps), port, send, toast, confirm, hold, attach, settings };
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

/** 参加を頼み、ネイティブが参加を確かめた状態（joined・一覧に載る）まで進める */
async function joined(h: Harness, over: Partial<Parameters<typeof snap>[0]> = {}) {
  await h.store.join();
  const session = h.port.starts.at(-1)!.session;
  h.port.pushState(snap({ session, phase: 'joined', listed: true, generation: 2, seq: 1, peer: 'p-self', members: [member('p-self', 'me')], ...over }));
  await flush();
  return session;
}

function member(peer: string, userId: string, muted = false) {
  return { peer, user_id: userId, status: { muted, deafened: false, device: 'laptop' } };
}

let h: Harness;
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('AudioContext', undefined);
  serverNow = 'http://srv.test';
  h = make();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ネイティブ所有の通話: JS は、マイク・音・チャットの参加を持たない', () => {
  it('参加は native に頼む。マイク（getUserMedia）も、常駐（hold）も、AudioContext も使わない', async () => {
    expect(navigator.mediaDevices).toBeUndefined(); // 無いので、JS 側の経路なら失敗して toast が出る
    await h.store.join();
    expect(h.port.starts).toHaveLength(1);
    expect(h.port.starts[0]).toMatchObject({ expectedUserId: 'me', serverUrl: 'http://srv.test', devUser: null, status: { muted: false, deafened: false, device: 'laptop' } });
    expect(h.hold).not.toHaveBeenCalled();
    expect(h.attach).not.toHaveBeenCalled();
    expect(h.toast).not.toHaveBeenCalled();
    expect(h.store.joining).toBe(true);
  });

  it('参加のあいだ、JS からチャットの call.join・call.* は送られない', async () => {
    await joined(h);
    h.store.toggleMute();
    await h.store.kick('u1');
    h.store.emit('game', { a: 1 });
    expect(h.send.mock.calls.map((c) => (c[0] as ClientEvent).type).filter((t) => t.startsWith('call.'))).toEqual([]);
  });

  it('参加を頼んだが受け付けられないと、参加中にはならず、トーストで知らせる（その後、勝手に入らない）', async () => {
    h.port.startError = { code: 'mic_denied', message: '許可されていません（http://secret.example/x）' };
    await h.store.join();
    expect(h.store.joined).toBe(false);
    expect(h.store.joining).toBe(false);
    expect(h.toast).toHaveBeenCalledWith('通話に参加できませんでした（コード: mic_denied）', 'error');
    expect(h.toast.mock.calls.flat().join('')).not.toContain('secret');
    expect(h.port.starts).toHaveLength(1);
  });

  it('joinMuted の設定は、参加の頼みに渡す（ネイティブがミュートで始める）', async () => {
    h = make({ joinMuted: true });
    await h.store.join();
    expect(h.port.starts[0]!.status.muted).toBe(true);
  });
});

describe('ネイティブの状態を画面へ写す（判断はネイティブ）', () => {
  it('受け付けた参加（joining）→ 確かめた参加（joined・一覧に載る）の順で画面が変わる', async () => {
    await h.store.join();
    expect(h.store.joining).toBe(true);
    expect(h.store.joined).toBe(false);
    const session = h.port.starts[0]!.session;
    h.port.pushState(snap({ session, phase: 'joined', listed: false, peer: 'p-self', generation: 2, seq: 1 }));
    await flush();
    expect(h.store.joined).toBe(true);
    expect(h.store.listed).toBe(false);
    expect(h.store.pending).toBe(true);
    h.port.pushState(snap({ session, phase: 'joined', listed: true, peer: 'p-self', generation: 2, seq: 2, members: [member('p-self', 'me'), member('p-u1', 'u1')] }));
    await flush();
    expect(h.store.listed).toBe(true);
    expect(h.store.participants.map((p) => [p.peer, p.self])).toEqual([
      ['p-self', true],
      ['p-u1', false],
    ]);
  });

  it('ミュート・スピーカーミュートは、ネイティブの状態のとおりに出す（JS で計算しない）', async () => {
    await joined(h);
    h.port.pushState(snap({ session: h.port.starts[0]!.session, phase: 'joined', listed: true, peer: 'p-self', generation: 2, seq: 5, muted: true, deafened: true, muteByDeafen: true, members: [member('p-self', 'me')] }));
    await flush();
    expect(h.store.muted).toBe(true);
    expect(h.store.deafened).toBe(true);
    expect(h.store.participants[0]).toMatchObject({ self: true, muted: true, deafened: true });
  });

  it('古い世代・同じ世代で戻った seq の状態は無視する', async () => {
    const session = await joined(h, { generation: 4, seq: 10 });
    h.port.pushState(snap({ session, phase: 'idle', generation: 3, seq: 99 }));
    h.port.pushState(snap({ session, phase: 'idle', generation: 4, seq: 10 }));
    await flush();
    expect(h.store.joined).toBe(true);
  });

  it('チャットの接続が切れても、ネイティブの通話は止めない（トーストも出さない）。表示はネイティブの linkUp に従う', async () => {
    await joined(h);
    h.store.onLink(false);
    expect(h.toast).not.toHaveBeenCalled();
    expect(h.store.joined).toBe(true);
    h.port.pushState(snap({ session: h.port.starts[0]!.session, phase: 'recovering', linkUp: false, listed: false, peer: 'p-self', generation: 2, seq: 7 }));
    await flush();
    expect(h.store.joined).toBe(true);
    expect(h.store.linkDown).toBe(true);
    expect(h.store.pending).toBe(true);
  });

  it('同じエラーは一度だけ知らせる。kick は外された人の名前で知らせる', async () => {
    const session = await joined(h);
    const err = { code: 'network', message: 'http://secret.example/x' };
    h.port.pushState(snap({ session, phase: 'recovering', linkUp: false, peer: 'p-self', generation: 2, seq: 8, error: err }));
    h.port.pushState(snap({ session, phase: 'recovering', linkUp: false, peer: 'p-self', generation: 2, seq: 9, error: err }));
    await flush();
    expect(h.toast.mock.calls.filter((c) => String(c[0]).includes('network'))).toHaveLength(1);
    expect(h.toast).toHaveBeenCalledWith('通話でエラーが起きました（コード: network）', 'error');
    h.port.pushState(snap({ session, phase: 'idle', peer: null, generation: 3, seq: 0, error: { code: 'kicked', message: '', by: 'u1' } }));
    await flush();
    expect(h.toast).toHaveBeenCalledWith('たろうさんに通話から外されました', 'info');
  });

  it('参加中の一覧は、ネイティブの members を使う。参加していないあいだは、チャットの一覧（call.state）を使う', async () => {
    const room = [member('p-x', 'u1')];
    h.store.onServerEvent({ type: 'call.state', members: room } as ServerEvent);
    expect(h.store.visible).toBe(true);
    expect(h.store.participants.map((p) => p.peer)).toEqual(['p-x']);
    await joined(h, { members: [member('p-self', 'me')] });
    h.store.onServerEvent({ type: 'call.state', members: [] } as ServerEvent);
    expect(h.store.participants.map((p) => p.peer)).toEqual(['p-self']);
  });

  it('チャットの hello で、JS が入り直すことはない（ネイティブが再接続する）', async () => {
    await joined(h);
    h.store.onServerEvent({ type: 'hello' } as unknown as ServerEvent);
    expect(h.send.mock.calls.filter((c) => (c[0] as ClientEvent).type === 'call.join')).toHaveLength(0);
    expect(h.store.joined).toBe(true);
  });
});

describe('操作はネイティブに頼む（画面はネイティブの返事に従う）', () => {
  it('ミュート・スピーカーミュート・相手の消音は、目標の状態を頼む', async () => {
    const session = await joined(h, { members: [member('p-self', 'me'), member('p-u1', 'u1')] });
    h.store.toggleMute();
    expect(h.port.controls.at(-1)).toEqual([session, { muted: true }]);
    h.store.toggleDeafen();
    expect(h.port.controls.at(-1)).toEqual([session, { deafened: true }]);
    h.store.toggleLocalMute('p-u1');
    expect(h.port.controls.at(-1)).toEqual([session, { peerMute: { peer: 'p-u1', muted: true } }]);
  });

  it('自分の一覧にない相手の消音は頼まない', async () => {
    await joined(h);
    const before = h.port.controls.length;
    h.store.toggleLocalMute('p-nobody');
    expect(h.port.controls.length).toBe(before);
  });

  it('外す（kick）は、確認のあとでネイティブに頼む。確認しなければ頼まない', async () => {
    const session = await joined(h, { members: [member('p-self', 'me'), member('p-u1', 'u1')] });
    h.store.kick('p-u1');
    await flush();
    expect(h.confirm).toHaveBeenCalled();
    expect(h.port.kicks).toEqual([[session, 'p-u1']]);
    h = make({ confirmOk: false });
    await joined(h, { members: [member('p-self', 'me'), member('p-u1', 'u1')] });
    await h.store.kick('p-u1');
    expect(h.port.kicks).toHaveLength(0);
  });

  it('抜けると、直ちに画面を空にし、ネイティブへはその論理セッションの停止を送る', async () => {
    const session = await joined(h);
    h.store.leave();
    await flush();
    expect(h.store.joined).toBe(false);
    expect(h.store.listed).toBe(false);
    expect(h.port.stops).toEqual([[session, 'user']]);
  });

  it('参加の途中で抜けると、ネイティブの開始は止まり、画面は参加していない状態になる', async () => {
    h.port.startGate = { promise: new Promise(() => {}), resolve: () => {}, reject: () => {} };
    const p = h.store.join();
    await flush();
    h.store.leave();
    await flush();
    expect(h.store.joining).toBe(false);
    expect(h.port.stops).toHaveLength(1);
    void p;
  });

  it('接続先を別のものに変えると、いまの論理セッションだけを止める（新しいサーバーへは自動で入らない）', async () => {
    const session = await joined(h);
    serverNow = 'http://other.test';
    h.store.onServerChanged();
    await flush();
    expect(h.port.stops).toEqual([[session, 'server-change']]);
    expect(h.store.joined).toBe(false);
    expect(h.toast).toHaveBeenCalledWith(expect.stringContaining('接続先が変わった'), 'info');
    expect(h.port.starts).toHaveLength(1);
  });

  it('接続先を空にした（明示的に外した）ときも、いまの論理セッションを止める', async () => {
    const session = await joined(h);
    serverNow = '';
    h.store.onServerChanged();
    expect(h.port.stops).toEqual([[session, 'server-change']]);
  });

  it('設定の読み込みで、同じ接続先が入っても止めない（末尾の / などの違いも同じ）', async () => {
    const session = await joined(h);
    h.store.onServerChanged();
    serverNow = 'http://srv.test/';
    h.store.onServerChanged();
    expect(h.port.stops).toHaveLength(0);
    expect(h.store.joined).toBe(true);
    expect(session).toBeTruthy();
  });

  it('起動のときに、回復中の通話を採用し、読み込みで同じ接続先が入っても、通話は続く（新しく参加はしない）', async () => {
    serverNow = '';
    h.port.current = snap({ session: 'REC', phase: 'recovering', listed: false, linkUp: false, peer: 'p-self', generation: 12, seq: 0, serverUrl: 'http://srv.test' });
    await h.store.adoptNative();
    expect(h.store.joined).toBe(true);
    // 読み込みで、接続先が（未設定から）同じ値になる
    serverNow = 'http://srv.test';
    h.store.onServerChanged();
    await flush();
    expect(h.port.stops).toHaveLength(0);
    expect(h.port.starts).toHaveLength(0);
    expect(h.store.joined).toBe(true);
    // 本当に別のサーバーになったら止める（古い論理セッションだけ）
    serverNow = 'http://other.test';
    h.store.onServerChanged();
    expect(h.port.stops).toEqual([['REC', 'server-change']]);
  });

  it('止められなかったら、通話は画面に残り、固定のエラーを一度だけ知らせる。もう一度止められる', async () => {
    const session = await joined(h);
    h.port.stopError = { code: 'busy', message: 'http://secret.example' };
    h.store.leave();
    await flush();
    expect(h.store.joined).toBe(true);
    expect(h.toast.mock.calls.filter((c) => String(c[0]).includes('もう一度'))).toHaveLength(1);
    expect(h.toast.mock.calls.flat().join('')).not.toContain('secret');
    h.port.stopError = null;
    h.store.leave();
    await flush();
    expect(h.store.joined).toBe(false);
    expect(h.port.stops).toEqual([
      [session, 'user'],
      [session, 'user'],
    ]);
  });

  it('参加していないときのサーバーの変更は、何も送らない', () => {
    h.store.onServerChanged();
    expect(h.port.stops).toHaveLength(0);
  });

  it('音量・上限・既定の出力先の設定が変わると、ネイティブへ送る（参加中だけ）。保存したときはすぐ送る', async () => {
    h.settings.patch({ limitDb: -6 });
    expect(h.port.controls).toHaveLength(0);
    const session = await joined(h);
    h.settings.patch({ limitDb: -9, micVolume: 0.5 });
    const last = h.port.controls.at(-1)!;
    expect(last[0]).toBe(session);
    expect(last[1]).toMatchObject({ settings: { limitDb: -9, micVolume: 0.5, rawInput: false, outputId: null } });
  });

  it('動かしている途中の音量は、まとめて（約 50ms）、最後の値だけを送る。保存したら、待たずに送る', async () => {
    await joined(h);
    const before = h.port.controls.length;
    h.settings.preview({ micVolume: 0.2 });
    h.settings.preview({ micVolume: 0.4 });
    h.settings.preview({ micVolume: 0.6 });
    expect(h.port.controls.length).toBe(before);
    await new Promise((r) => setTimeout(r, 90));
    const sent = h.port.controls.slice(before).filter((c) => 'settings' in c[1]);
    expect(sent).toHaveLength(1);
    expect(sent[0]![1]).toMatchObject({ settings: { micVolume: 0.6 } });
    h.settings.preview({ micVolume: 0.9 });
    h.settings.save();
    expect(h.port.controls.slice(before).filter((c) => 'settings' in c[1]).at(-1)![1]).toMatchObject({ settings: { micVolume: 0.9 } });
  });

  it('ミュート・スピーカーミュート・外すは、まとめずに、そのまま送る（間を空けない）', async () => {
    const session = await joined(h, { members: [member('p-self', 'me'), member('p-u1', 'u1')] });
    const before = h.port.controls.length;
    h.store.toggleMute();
    h.store.toggleMute();
    h.store.toggleDeafen();
    expect(h.port.controls.slice(before)).toEqual([
      [session, { muted: true }],
      [session, { muted: false }],
      [session, { deafened: true }],
    ]);
  });
});

describe('プラグインの emit・中継（音声は JS へ届かない）', () => {
  it('参加の前の emit は、ネイティブに頼まない。予約の名前は、いつでも使えない。参加していなければ例外', async () => {
    expect(() => h.store.emit('game', 1)).toThrow();
    const session = await joined(h);
    expect(() => h.store.emit('audio', 1)).toThrow();
    h.store.emit('game', { x: 1 });
    expect(h.port.emits).toEqual([[session, 'game', { x: 1 }]]);
  });

  it('一覧に載る前の emit は積んで、載ったら順にネイティブへ送る', async () => {
    await h.store.join();
    const session = h.port.starts[0]!.session;
    h.port.pushState(snap({ session, phase: 'joined', listed: false, peer: 'p-self', generation: 2, seq: 1 }));
    await flush();
    h.store.emit('a', 1);
    h.store.emit('b', 2);
    expect(h.port.emits).toHaveLength(0);
    h.port.pushState(snap({ session, phase: 'joined', listed: true, peer: 'p-self', generation: 2, seq: 2 }));
    await flush();
    expect(h.port.emits).toEqual([
      [session, 'a', 1],
      [session, 'b', 2],
    ]);
  });

  it('中継は onEvent に届く（送った人の名前つき）。音声の名前は、JS へ届けない', async () => {
    await joined(h);
    const cb = vi.fn();
    h.store.onEvent('game', cb);
    const session = h.port.starts[0]!.session;
    h.port.pushRelay(session, 2, 3, 'p-u1', 'u1', 'game', { hi: true });
    h.port.pushRelay(session, 2, 4, 'p-u1', 'u1', 'audio', { pcm: 'AAAA' });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ peer: 'p-u1', userId: 'u1', payload: { hi: true } });
    // 音声の名前で購読されていても、JS へは届けない（音声はネイティブだけが扱う）
    const audioCb = vi.fn();
    h.store.onEvent('audio', audioCb);
    h.port.pushRelay(session, 2, 5, 'p-u1', 'u1', 'audio', { pcm: 'AAAA' });
    expect(audioCb).not.toHaveBeenCalled();
  });

  it('ネイティブの中継のコールバックが投げた値を診断へ流さない', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const session = await joined(h);
    const secret = 'SENTINEL_CUSTOM_EVENT_PAYLOAD';
    h.store.onEvent('game', () => { throw { secret }; });
    h.port.pushRelay(session, 2, 3, 'p-u1', 'u1', 'game', { secret });
    expect(error).toHaveBeenCalledWith('[call] プラグインのコールバックで例外');
    expect(JSON.stringify(error.mock.calls)).not.toContain(secret);
  });
});

describe('起動時の採用（読むだけ。参加を始めない）', () => {
  it('回復中の通話を採用すると、画面は参加中になり、新しい参加は頼まない', async () => {
    h.port.current = snap({ session: 'REC', phase: 'recovering', listed: false, linkUp: false, peer: 'p-self', generation: 9, seq: 0 });
    await h.store.adoptNative();
    expect(h.store.joined).toBe(true);
    expect(h.store.linkDown).toBe(true);
    expect(h.port.starts).toHaveLength(0);
    h.store.leave();
    expect(h.port.stops).toEqual([['REC', 'user']]);
  });

  it('止まっている状態を読んでも、何も始めない（画面も参加中にしない）', async () => {
    h.port.current = snap({ phase: 'idle', generation: 4 });
    await h.store.adoptNative();
    expect(h.store.joined).toBe(false);
    expect(h.port.starts).toHaveLength(0);
  });
});

describe('ネイティブ所有でないとき（Windows・Linux・テストの従来経路）は変わらない', () => {
  it('deps.native が無いと、nativeOwned は false で、従来の参加を使う（マイクが無ければ失敗の toast）', async () => {
    const toast = vi.fn();
    const store = new CallStore({
      send: vi.fn(),
      meId: () => 'me',
      nameOf: () => '',
      toast,
      confirm: async () => true,
      hold: vi.fn(async () => Object.assign(() => {}, { update: () => {} })),
      audio: { listOutputs: async () => [], setOutput: async () => true, listInputs: async () => [], attach: () => () => {} },
      settings: new CallSettings(createCallSource()),
      deviceKind: () => 'laptop',
      openSettings: () => {},
      now: () => 0,
    });
    expect(store.nativeOwned).toBe(false);
    await store.join();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('マイクを使えません'), 'error');
  });
});

describe('失敗の知らせ（任意の文章・例外を出さない。成功の「抜けました」は、ack のあとだけ）', () => {
  const SECRET = 'SECRET-7f3a-http://leak.example';

  it('接続先が変わって停止が拒否されたら、「抜けました」は出さず、失敗の一度だけ。通話は残る', async () => {
    const session = await joined(h);
    h.port.stopError = { code: 'busy' };
    serverNow = 'http://other.test';
    h.store.onServerChanged();
    await flush();
    expect(h.port.stops).toEqual([[session, 'server-change']]);
    expect(h.toast.mock.calls.flat().join('')).not.toContain('抜けました');
    expect(h.toast.mock.calls.filter((c) => String(c[0]).includes('もう一度'))).toHaveLength(1);
    expect(h.store.joined).toBe(true);
  });

  it('接続先が変わって、停止が受け付けられるまで「抜けました」は出さない。受け付けられたあとに出す', async () => {
    await joined(h);
    let release!: () => void;
    const acked = new Promise<void>((r) => (release = r));
    h.port.stop = async (sid: string, reason: string) => {
      h.port.stops.push([sid, reason]);
      await acked;
    };
    serverNow = 'http://other.test';
    h.store.onServerChanged();
    await flush();
    expect(h.toast.mock.calls.flat().join('')).not.toContain('抜けました');
    expect(h.store.joined).toBe(true);
    release();
    await flush();
    expect(h.toast).toHaveBeenCalledWith('接続先が変わったので、通話から抜けました', 'info');
    expect(h.store.joined).toBe(false);
  });

  it('採用の読み込みが失敗しても、中身（任意の文章）は出さず、固定の文で記録する', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.port.snapshotError = { code: 'busy', message: SECRET };
    await h.store.adoptNative();
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('leak.example');
  });

  it('設定の通知の処理が例外を投げても、投げた中身は記録しない', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const settings = new CallSettings(createCallSource());
    settings.onChange(() => {
      throw { secret: SECRET };
    });
    settings.patch({ limitDb: -6 });
    expect(error).toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).not.toContain('SECRET');
  });
});


describe('読み込みのあいだに接続先が変わった（採用・参加の後に一度だけ確かめる）', () => {
  it('回復中の通話（旧い接続先）の読み込みが終わるまでに、接続先が新しくなったら、採用のあとに、その古い論理セッションだけを止める', async () => {
    const { deferred, snap: snapOf } = await import('./nativeFake');
    const gate = deferred<void>();
    h.port.snapshotGate = gate;
    h.port.current = snapOf({ session: 'REC', phase: 'joined', listed: true, peer: 'p-self', generation: 6, seq: 1, serverUrl: 'http://old.test' });
    const p = h.store.adoptNative();
    serverNow = 'http://new.test';
    h.store.onServerChanged(); // 読み込み中: まだ通話が無いので、ここでは止めない
    await flush();
    expect(h.port.stops).toHaveLength(0);
    gate.resolve();
    await p;
    await flush();
    expect(h.port.stops).toEqual([['REC', 'server-change']]);
    expect(h.port.starts).toHaveLength(0);
    expect(h.toast).toHaveBeenCalledWith('接続先が変わったので、通話から抜けました', 'info');
    expect(h.store.joined).toBe(false);
  });

  it('読み込みより前に接続先が新しくなっていても、採用のあとに古い論理セッションだけを止める', async () => {
    h.port.current = snap({ session: 'REC', phase: 'recovering', listed: false, linkUp: false, peer: 'p-self', generation: 6, seq: 1, serverUrl: 'http://old.test' });
    serverNow = 'http://new.test';
    await h.store.adoptNative();
    await flush();
    expect(h.port.stops).toEqual([['REC', 'server-change']]);
    expect(h.port.starts).toHaveLength(0);
  });

  it('読み込みのあいだに接続先が同じ値に入っても（同じ URL の初期化）止めない', async () => {
    const { deferred, snap: snapOf } = await import('./nativeFake');
    const gate = deferred<void>();
    h.port.snapshotGate = gate;
    h.port.current = snapOf({ session: 'REC', phase: 'joined', listed: true, peer: 'p-self', generation: 6, seq: 1, serverUrl: 'http://srv.test' });
    const p = h.store.adoptNative();
    serverNow = 'http://srv.test/';
    h.store.onServerChanged();
    gate.resolve();
    await p;
    await flush();
    expect(h.port.stops).toHaveLength(0);
    expect(h.store.joined).toBe(true);
  });

  it('参加の途中で回復中の通話が見つかり、接続先が違うなら、参加はせず古い通話だけを止める（新しい接続先では始めない）', async () => {
    h.port.current = snap({ session: 'REC', phase: 'recovering', listed: false, linkUp: false, peer: 'p-self', generation: 6, seq: 1, serverUrl: 'http://old.test' });
    serverNow = 'http://new.test';
    await h.store.join();
    await flush();
    expect(h.port.starts).toHaveLength(0);
    expect(h.port.stops).toEqual([['REC', 'server-change']]);
    expect(h.store.joined).toBe(false);
  });

  it('止められなかったら、通話は残り、失敗は一度だけ。成功の「抜けました」は出さない', async () => {
    h.port.current = snap({ session: 'REC', phase: 'joined', listed: true, peer: 'p-self', generation: 6, seq: 1, serverUrl: 'http://old.test' });
    h.port.stopError = { code: 'busy' };
    serverNow = 'http://new.test';
    await h.store.adoptNative();
    await flush();
    expect(h.store.joined).toBe(true);
    expect(h.toast.mock.calls.flat().join('')).not.toContain('抜けました');
    expect(h.toast.mock.calls.filter((c) => String(c[0]).includes('もう一度'))).toHaveLength(1);
    // 生きている状態が続いても、確かめ直して止めに行かない（状態の更新ごとに止めない）
    h.port.pushState(snap({ session: 'REC', phase: 'joined', listed: true, peer: 'p-self', generation: 6, seq: 2, serverUrl: 'http://old.test', speaking: { 'p-self': true } }));
    h.port.pushState(snap({ session: 'REC', phase: 'joined', listed: true, peer: 'p-self', generation: 6, seq: 3, serverUrl: 'http://old.test', speaking: { 'p-self': false } }));
    await flush();
    expect(h.port.stops).toHaveLength(1);
    expect(h.toast.mock.calls.filter((c) => String(c[0]).includes('もう一度'))).toHaveLength(1);
  });
});

describe('頼んだ開始の返事が失敗したとき（画面は確かめた状態に従う。勝手に消さない）', () => {
  /** 開始は受け付けられた（ネイティブは続けている）が、返事だけ失敗する */
  function rejectAfterStart(h2: Harness, after: 'joined' | 'fail') {
    const port = h2.port;
    port.start = async (args) => {
      port.starts.push(args);
      port.current = snap({ session: args.session, generation: 9, seq: 1, phase: 'joining', peer: 'p-self', serverUrl: args.serverUrl });
      if (after === 'joined') port.current = snap({ session: args.session, generation: 9, seq: 2, phase: 'joined', listed: true, peer: 'p-self', serverUrl: args.serverUrl });
      else port.snapshotError = { code: 'ipc', message: 'http://secret.example/x' };
      throw { code: 'ipc', message: 'http://secret.example/x' };
    };
  }

  it('返事が失敗しても、読み直しで参加中と分かれば、参加中のまま。失敗の知らせは出さない', async () => {
    rejectAfterStart(h, 'joined');
    await h.store.join();
    await flush();
    expect(h.store.joined).toBe(true);
    expect(h.toast.mock.calls.flat().join('')).not.toContain('参加できませんでした');
    expect(h.toast.mock.calls.flat().join('')).not.toContain('確かめられません');
    expect(h.port.starts).toHaveLength(1);
  });

  it('読み直しも失敗したら、参加中のまま残し、「確かめられません」を一度だけ知らせる。退出で止められる（固定の文）', async () => {
    rejectAfterStart(h, 'fail');
    await h.store.join();
    await flush();
    expect(h.store.joining).toBe(true);
    const unknown = h.toast.mock.calls.filter((c) => String(c[0]).includes('確かめられません'));
    expect(unknown).toHaveLength(1);
    expect(unknown[0]![0]).toContain('コード: ipc');
    expect(h.toast.mock.calls.flat().join('')).not.toContain('secret');
    expect(h.port.starts).toHaveLength(1);
    h.port.snapshotError = null;
    const sid = h.port.starts[0]!.session;
    h.store.leave();
    await flush();
    expect(h.port.stops).toEqual([[sid, 'user']]);
  });
});

describe('読み込みのあいだの接続先の「空にした」知らせ（明示的な変更は取りこぼさない）', () => {
  it('回復中の通話の読み込みのあいだに、接続先を空にした知らせが来たら、採用のあとに古い論理セッションだけを止める', async () => {
    const { deferred, snap: snapOf } = await import('./nativeFake');
    const gate = deferred<void>();
    h.port.snapshotGate = gate;
    h.port.current = snapOf({ session: 'REC', phase: 'joined', listed: true, peer: 'p-self', generation: 6, seq: 1, serverUrl: 'http://old.test' });
    const p = h.store.adoptNative();
    serverNow = '';
    h.store.onServerChanged(); // 明示的に空にした知らせ（読み込み中）
    gate.resolve();
    await p;
    await flush();
    expect(h.port.stops).toEqual([['REC', 'server-change']]);
    expect(h.port.starts).toHaveLength(0);
    expect(h.store.joined).toBe(false);
  });

  it('知らせの無い空の値（まだ整っていない初期化）では、読み込みのあとも止めない', async () => {
    const { deferred, snap: snapOf } = await import('./nativeFake');
    const gate = deferred<void>();
    h.port.snapshotGate = gate;
    h.port.current = snapOf({ session: 'REC', phase: 'joined', listed: true, peer: 'p-self', generation: 6, seq: 1, serverUrl: 'http://srv.test' });
    const p = h.store.adoptNative();
    serverNow = '';
    gate.resolve();
    await p;
    await flush();
    expect(h.port.stops).toHaveLength(0);
    expect(h.store.joined).toBe(true);
  });

  it('読み込みの前の古い知らせは、後の採用に持ち越さない（読み込みが終わったら覚えは消す）', async () => {
    h.port.current = snap({ session: 'REC', phase: 'joined', listed: true, peer: 'p-self', generation: 6, seq: 1, serverUrl: 'http://srv.test' });
    serverNow = '';
    h.store.onServerChanged(); // 読み込みの外（まだ何も採用していない）
    await h.store.adoptNative();
    await flush();
    expect(h.port.stops).toHaveLength(0);
    expect(h.store.joined).toBe(true);
  });
});
