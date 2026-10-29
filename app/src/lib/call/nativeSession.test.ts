import { describe, expect, it, vi } from 'vitest';
import { NativeCallSession, type NativeSessionHooks, type NativeStartInput } from './nativeSession';
import { FakeNativePort, deferred, snap } from './nativeFake';
import type { NativeSnapshot } from './native';

const input: NativeStartInput = {
  serverUrl: 'http://srv.test',
  expectedUserId: 'me',
  devUser: null,
  status: { muted: false, deafened: false, device: 'laptop' },
  settings: { micVolume: 1, outVolume: 1, limiter: true, limitDb: -3, rawInput: false, outputId: null },
};

function setup() {
  const port = new FakeNativePort();
  const hooks = {
    onSnapshot: vi.fn<(s: NativeSnapshot) => void>(),
    onRelay: vi.fn(),
    onStartFailed: vi.fn(),
    onStartUnknown: vi.fn(),
    onStopped: vi.fn(),
    onStopFailed: vi.fn(),
  };
  const session = new NativeCallSession(port, hooks as unknown as NativeSessionHooks);
  return { port, hooks, session };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('NativeCallSession（論理セッションで、古い開始・停止を区別する）', () => {
  it('開始は token を付けて頼み、受け付けた snapshot を画面へ渡す（参加の完了は待たない）', async () => {
    const { port, hooks, session } = setup();
    await session.start(input);
    expect(port.starts).toHaveLength(1);
    expect(port.starts[0]!.session).toMatch(/.+/);
    expect(port.starts[0]!.expectedUserId).toBe('me');
    expect(hooks.onSnapshot).toHaveBeenCalledTimes(1);
    expect(session.session).toBe(port.starts[0]!.session);
  });

  it('頼む前に止められたら、ネイティブへは何も頼まない（開始も停止も送らない）', async () => {
    const { port, hooks, session } = setup();
    const p = session.start(input);
    await session.stop('user');
    await p;
    expect(port.starts).toHaveLength(0);
    expect(port.stops).toHaveLength(0);
    expect(hooks.onStopped).toHaveBeenCalledTimes(1);
    expect(session.active).toBe(false);
  });

  it('頼んだあとで止めたら、その token の停止を送り、遅れて届いた開始の応答は捨てる', async () => {
    const { port, hooks, session } = setup();
    const gate = deferred<NativeSnapshot>();
    port.startGate = gate;
    const p = session.start(input);
    await flush();
    const token = port.starts[0]!.session;
    await session.stop('user');
    expect(port.stops).toEqual([[token, 'user']]);
    gate.resolve(snap({ session: token, phase: 'joining', generation: 5 }));
    await p;
    expect(hooks.onSnapshot).not.toHaveBeenCalled();
    expect(session.active).toBe(false);
  });

  it('止めたあとに新しく頼んだ開始は、古い停止で止まらない（古い停止は古い token だけを指す）', async () => {
    const { port, session } = setup();
    const gate = deferred<NativeSnapshot>();
    port.startGate = gate;
    const first = session.start(input);
    await flush();
    const oldToken = port.starts[0]!.session;
    await session.stop('user');
    port.startGate = null;
    await session.start(input);
    const newToken = port.starts[1]!.session;
    expect(newToken).not.toBe(oldToken);
    expect(port.stops).toEqual([[oldToken, 'user']]);
    gate.resolve(snap({ session: oldToken, phase: 'joining' }));
    await first;
    expect(session.session).toBe(newToken);
  });

  it('開始を拒否されたら、token を消し、停止は送らない（残す物は何も無い）', async () => {
    const { port, hooks, session } = setup();
    port.startError = { code: 'mic_denied', message: '許可されていません' };
    await session.start(input);
    expect(hooks.onStartFailed).toHaveBeenCalledWith('mic_denied');
    expect(session.active).toBe(false);
    expect(port.stops).toHaveLength(0);
    await session.stop('user');
    expect(port.stops).toHaveLength(0);
  });

  it('起動のとき、回復中・参加中の通話は採用する（読むだけ。開始は頼まない）', async () => {
    const { port, hooks, session } = setup();
    port.current = snap({ session: 'S1', phase: 'recovering', generation: 4, seq: 3, peer: 'p1' });
    await session.adopt();
    expect(port.starts).toHaveLength(0);
    expect(session.session).toBe('S1');
    expect(hooks.onSnapshot).toHaveBeenCalledTimes(1);
    await session.stop('user');
    expect(port.stops).toEqual([['S1', 'user']]);
  });

  it('起動のとき、止まっている状態なら何も採用しない。停止も送らない', async () => {
    const { port, session } = setup();
    port.current = snap({ phase: 'idle', generation: 2 });
    await session.adopt();
    expect(session.active).toBe(false);
    await session.stop('user');
    expect(port.stops).toHaveLength(0);
  });

  it('古い世代の状態は捨てる（同じ世代で seq が戻ったものも捨てる）', async () => {
    const { port, hooks, session } = setup();
    await session.adopt();
    hooks.onSnapshot.mockClear();
    port.pushState(snap({ session: 'S', phase: 'joined', generation: 3, seq: 4 }));
    port.pushState(snap({ session: 'S', phase: 'idle', generation: 2, seq: 99 }));
    port.pushState(snap({ session: 'S', phase: 'joined', generation: 3, seq: 4 }));
    expect(hooks.onSnapshot).toHaveBeenCalledTimes(1);
    expect(session.session).toBe('S');
  });

  it('別の論理セッションが参加中なら（より新しい世代で）採用する', async () => {
    const { port, session } = setup();
    await session.adopt();
    port.pushState(snap({ session: 'R', phase: 'joined', generation: 7, seq: 1 }));
    expect(session.session).toBe('R');
    await session.stop('user');
    expect(port.stops).toEqual([['R', 'user']]);
  });

  it('中継は、いまの論理セッションのものだけ通す（古い session・止まったあとは捨てる）', async () => {
    const { port, hooks, session } = setup();
    await session.adopt();
    port.pushState(snap({ session: 'S', phase: 'joined', generation: 2, seq: 1 }));
    port.pushRelay('OLD', 2, 2, 'p2', 'u2', 'game', { a: 1 });
    expect(hooks.onRelay).not.toHaveBeenCalled();
    port.pushRelay('S', 2, 3, 'p2', 'u2', 'game', { a: 2 });
    expect(hooks.onRelay).toHaveBeenCalledTimes(1);
    expect(hooks.onRelay.mock.calls[0]![0]).toMatchObject({ session: 'S', from: 'u2', name: 'game', payload: { a: 2 } });
    port.pushRelay('S', 2, 3, 'p2', 'u2', 'game', { a: 3 });
    expect(hooks.onRelay).toHaveBeenCalledTimes(1);
    await session.stop('user');
    port.pushRelay('S', 2, 9, 'p2', 'u2', 'game', { a: 4 });
    expect(hooks.onRelay).toHaveBeenCalledTimes(1);
  });

  it('操作（操作・外す・送る）は、論理セッションが無いあいだは何も送らない', async () => {
    const { port, session } = setup();
    await session.control({ muted: true });
    await session.kick('p');
    await session.emit('n', 1);
    expect(port.controls).toHaveLength(0);
    expect(port.kicks).toHaveLength(0);
    expect(port.emits).toHaveLength(0);
    await session.start(input);
    const t = port.starts[0]!.session;
    await session.control({ muted: true });
    await session.kick('p');
    await session.emit('n', { x: 1 });
    expect(port.controls).toEqual([[t, { muted: true }]]);
    expect(port.kicks).toEqual([[t, 'p']]);
    expect(port.emits).toEqual([[t, 'n', { x: 1 }]]);
  });

  it('二重に頼んでも、開始は一度だけ（参加中の開始は無視する）', async () => {
    const { port, session } = setup();
    await session.start(input);
    await session.start(input);
    expect(port.starts).toHaveLength(1);
  });
});

/* ---- 停止・読み込み・採用の順序（チャットの接続とは別に、論理セッションの token で守る） ---- */

describe('停止の完了（ack）で初めて終わる。失敗したら状態を読み直し、生きていれば表示を残す', () => {
  it('停止が拒否されたら、停止は完了していない。通話は生きたまま残り、もう一度止められる', async () => {
    const { port, hooks, session } = setup();
    await session.start(input);
    const t = session.session!;
    port.stopError = { code: 'busy' };
    port.current = snap({ session: t, phase: 'joined', listed: true, peer: 'p', generation: 3, seq: 2 });
    await session.stop('user');
    expect(hooks.onStopFailed).toHaveBeenCalledTimes(1);
    expect(hooks.onStopped).not.toHaveBeenCalled();
    expect(session.session).toBe(t);
    expect(session.stopping).toBe(false);
    // 読み直しで生きていると分かった状態を、画面へ渡す（消さない）
    expect(hooks.onSnapshot.mock.calls.at(-1)![0]).toMatchObject({ session: t, phase: 'joined' });
    // もう一度止める（直前の停止とは別の要求として、同じ token に送る）
    port.stopError = null;
    await session.stop('user');
    expect(port.stops).toEqual([
      [t, 'user'],
      [t, 'user'],
    ]);
    expect(hooks.onStopped).toHaveBeenCalledTimes(1);
    expect(session.active).toBe(false);
  });

  it('停止が拒否されたあと、状態を読めなくても、通話は生きたまま残る（例外にしない）', async () => {
    const { port, hooks, session } = setup();
    await session.start(input);
    const t = session.session!;
    port.stopError = { code: 'busy' };
    port.snapshotError = { code: 'busy' };
    await session.stop('user');
    expect(session.session).toBe(t);
    expect(hooks.onStopFailed).toHaveBeenCalledTimes(1);
  });

  it('停止が拒否されたあと読み直すと止まっていた（ネイティブが終えた）なら、画面を空にする', async () => {
    const { port, hooks, session } = setup();
    await session.start(input);
    const t = session.session!;
    port.stopError = { code: 'busy' };
    port.current = snap({ session: null, phase: 'idle', generation: 9, seq: 0 });
    await session.stop('user');
    expect(session.session).toBe(null);
    expect(hooks.onSnapshot.mock.calls.at(-1)![0]).toMatchObject({ phase: 'idle' });
    expect(port.stops).toEqual([[t, 'user']]);
  });

  it('停止を頼んでいるあいだに届いた、同じ論理セッションの「生きている」状態は、画面に残すだけ（採用し直さない）', async () => {
    const { port, hooks, session } = setup();
    const gate = deferred<void>();
    await session.start(input);
    const t = session.session!;
    port.controlGate = gate;
    // 停止の完了を待たせる
    let release!: () => void;
    const stopped = new Promise<void>((r) => (release = r));
    port.stop = async (sid: string, reason: string) => {
      port.stops.push([sid, reason]);
      await stopped;
    };
    const p = session.stop('user');
    expect(session.stopping).toBe(true);
    port.pushState(snap({ session: t, phase: 'joined', generation: 5, seq: 1, peer: 'p' }));
    expect(session.session).toBe(t);
    expect(hooks.onSnapshot.mock.calls.at(-1)![0]).toMatchObject({ phase: 'joined' });
    release();
    await p;
    expect(hooks.onStopped).toHaveBeenCalledTimes(1);
    expect(session.session).toBe(null);
  });

  it('停止を頼んだあと、遅れた開始の受け付けは、止まった画面を参加中に戻さない', async () => {
    const { port, hooks, session } = setup();
    const gate = deferred<NativeSnapshot>();
    port.startGate = gate;
    const first = session.start(input);
    await flush();
    const t = port.starts[0]!.session;
    let release!: () => void;
    const stopped = new Promise<void>((r) => (release = r));
    port.stop = async (sid: string, reason: string) => {
      port.stops.push([sid, reason]);
      await stopped;
    };
    const p = session.stop('user');
    gate.resolve(snap({ session: t, phase: 'joined', listed: true, generation: 2, seq: 1 }));
    await first;
    expect(hooks.onSnapshot).not.toHaveBeenCalled();
    release();
    await p;
    expect(session.session).toBe(null);
    expect(port.stops).toEqual([[t, 'user']]);
  });

  it('停止を頼んだあとに、新しく頼んだ開始は、古い停止が終わるまで（ack まで）新しく始めない', async () => {
    const { port, session } = setup();
    await session.start(input);
    let release!: () => void;
    const stopped = new Promise<void>((r) => (release = r));
    port.stop = async (sid: string, reason: string) => {
      port.stops.push([sid, reason]);
      await stopped;
    };
    const p = session.stop('user');
    await session.start(input);
    expect(port.starts).toHaveLength(1);
    release();
    await p;
    await session.start(input);
    expect(port.starts).toHaveLength(2);
  });

  it('止めたあとの古い停止は、新しい論理セッションを止めない（停止は token に紐づく）', async () => {
    const { port, session } = setup();
    await session.start(input);
    const first = session.session!;
    await session.stop('user');
    await session.start(input);
    const second = session.session!;
    expect(second).not.toBe(first);
    // 古い論理セッションの停止の指示は、古い token だけを指す
    expect(port.stops.map((x) => x[0])).toEqual([first]);
    expect(session.session).toBe(second);
  });

  it('止めたあとに、ネイティブが同じ論理セッションを生きていると言っても、採用し直さない（新しい世代でも）', async () => {
    const { port, session } = setup();
    await session.start(input);
    const first = session.session!;
    await session.stop('user');
    port.pushState(snap({ session: first, phase: 'joined', generation: 99, seq: 1 }));
    expect(session.session).toBe(null);
  });
});

describe('開始の受け付けの前後で、読み込み・保留の状態を壊さない', () => {
  it('開始は読み込みが終わるまで頼まない。読み込みで回復中の通話が見つかれば、開始せず採用する', async () => {
    const { port, session } = setup();
    const gate = deferred<void>();
    port.snapshotGate = gate;
    port.current = snap({ session: 'REC', phase: 'recovering', generation: 7, seq: 0, peer: 'p' });
    const p = session.start(input);
    await flush();
    expect(port.starts).toHaveLength(0);
    gate.resolve();
    await p;
    expect(port.starts).toHaveLength(0);
    expect(session.session).toBe('REC');
  });

  it('読み込みで何も無ければ、開始を頼む', async () => {
    const { port, session } = setup();
    const gate = deferred<void>();
    port.snapshotGate = gate;
    port.current = snap({ phase: 'idle', generation: 7, seq: 0 });
    const p = session.start(input);
    await flush();
    expect(port.starts).toHaveLength(0);
    gate.resolve();
    await p;
    expect(port.starts).toHaveLength(1);
  });

  it('読み込みに失敗したら、開始は頼まない（二重に参加しないため）。エラーは固定の短いコードで知らせる', async () => {
    const { port, hooks, session } = setup();
    port.snapshotError = { code: 'busy', message: 'http://secret.example/x' };
    await session.start(input);
    expect(port.starts).toHaveLength(0);
    expect(hooks.onStartFailed).toHaveBeenCalledWith('state_unknown');
    expect(session.session).toBe(null);
  });

  it('開始を頼む前の「止まっている」状態は、開始を消さない', async () => {
    const { port, hooks, session } = setup();
    const gate = deferred<NativeSnapshot>();
    port.startGate = gate;
    const first = session.start(input);
    await flush();
    const t = port.starts[0]!.session;
    port.pushState(snap({ session: null, phase: 'idle', generation: 50, seq: 0 }));
    expect(session.session).toBe(t);
    gate.resolve(snap({ session: t, phase: 'joining', generation: 51, seq: 1 }));
    await first;
    expect(session.session).toBe(t);
    expect(hooks.onStartFailed).not.toHaveBeenCalled();
  });

  it('読み込みのあいだに止めた（開始は頼んでいない）なら、後で見つかった回復中の通話を止める', async () => {
    const { port, session } = setup();
    const gate = deferred<void>();
    port.snapshotGate = gate;
    port.current = snap({ session: 'REC', phase: 'joined', generation: 8, seq: 2, peer: 'p', serverUrl: 'http://srv.test' });
    const p = session.start(input);
    await flush();
    await session.stop('user');
    gate.resolve();
    await p;
    expect(port.starts).toHaveLength(0);
    expect(port.stops).toEqual([['REC', 'user']]);
  });

  it('同時に 2 回頼んでも、開始は 1 回。停止を頼んだ後の読み込みでも二重に送らない', async () => {
    const { port, session } = setup();
    await session.start(input);
    await session.start(input);
    expect(port.starts).toHaveLength(1);
  });

  it('採用した通話の接続先を覚える（比べるため）', async () => {
    const { port, session } = setup();
    port.current = snap({ session: 'REC', phase: 'joined', generation: 3, seq: 1, serverUrl: 'http://a.test' });
    await session.adopt();
    expect(session.serverUrl).toBe('http://a.test');
  });
});

describe('購読と破棄', () => {
  it('購読が終わる前に破棄されたら、後で届いた購読は直ちに外す。破棄のあとの出来事は画面へ渡さない', async () => {
    const { port, hooks, session } = setup();
    const gate = deferred<void>();
    port.listenGate = gate;
    const a = session.attach();
    session.dispose();
    gate.resolve();
    await a;
    expect(port.unlistenCount).toBe(1);
    port.current = snap({ session: 'S', phase: 'joined', generation: 2, seq: 1 });
    port.pushState(snap({ session: 'S', phase: 'joined', generation: 2, seq: 2 }));
    expect(hooks.onSnapshot).not.toHaveBeenCalled();
  });

  it('破棄は、ネイティブの通話を止めない（購読だけ外す）', async () => {
    const { port, session } = setup();
    await session.start(input);
    session.dispose();
    expect(port.stops).toHaveLength(0);
    expect(port.unlistenCount).toBe(1);
  });

  it('購読は一度だけ（何度 attach しても二重に登録しない）', async () => {
    const { port, session } = setup();
    await session.attach();
    await session.attach();
    expect(port.listenCount).toBe(1);
  });
});

describe('設定の送り方（まとめて、同時に1つ）', () => {
  it('送っているあいだに来た設定は、最後の値にまとめて、続けて1回だけ送る', async () => {
    const { port, session } = setup();
    await session.start(input);
    const gate = deferred<void>();
    port.controlGate = gate;
    session.setSettings({ micVolume: 0.2 });
    session.setSettings({ micVolume: 0.5 });
    session.setSettings({ micVolume: 0.7, limitDb: -6 });
    await flush();
    expect(port.controls.filter((c) => 'settings' in c[1])).toHaveLength(1);
    gate.resolve();
    await flush();
    await flush();
    const sent = port.controls.filter((c) => 'settings' in c[1]);
    expect(sent).toHaveLength(2);
    expect(sent[1]![1]).toEqual({ settings: { micVolume: 0.7, limitDb: -6 } });
  });

  it('参加していない・止めたあとは、設定を送らない', async () => {
    const { port, session } = setup();
    session.setSettings({ micVolume: 0.3 });
    await flush();
    expect(port.controls).toHaveLength(0);
  });
});

describe('記録（任意の文章・例外の中身を出さない）', () => {
  it('停止・読み込みの失敗は、固定の文と短いコードだけを記録する', async () => {
    const SECRET = 'SECRET-9c1e-http://leak.example';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { port, session } = setup();
    await session.start(input);
    port.stopError = { code: 'busy', message: SECRET };
    await session.stop('user');
    port.snapshotError = { code: 'busy', message: SECRET };
    await session.adopt();
    expect(warn.mock.calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('leak.example');
    warn.mockRestore();
  });
});


/* ---- 頼んだ開始が返事を返さなかったとき（生きているかもしれない）。読み直して確かめてから決める ---- */

/** 開始は受け付けられた（ネイティブは参加を続けている）が、返事だけ失敗する。次の読み直しの結果を指定できる */
function rejectedStart(port: FakeNativePort, after: { snapshot?: Partial<NativeSnapshot> | 'fail'; code?: string }) {
  const seen: { session: string }[] = [];
  port.start = async (args) => {
    port.starts.push(args);
    seen.push({ session: args.session });
    const reread = after.snapshot;
    if (reread === 'fail') port.snapshotError = { code: 'ipc', message: 'http://secret.example/x' };
    else if (reread) port.current = snap({ session: args.session, generation: 9, seq: 1, ...reread });
    throw { code: after.code ?? 'ipc', message: 'http://secret.example/x' };
  };
  return { token: () => seen[0]!.session };
}

describe('頼んだあとの失敗は、読み直して確かめてから決める（頼み直さない・見えないまま残さない）', () => {
  it('返事の失敗のあと、読み直しで同じ論理セッションが参加中なら、採用したまま見せる（終えたことにはしない）', async () => {
    const { port, hooks, session } = setup();
    const r = rejectedStart(port, { snapshot: { phase: 'joined', listed: true, peer: 'p-self' } });
    await session.start(input);
    expect(session.session).toBe(r.token());
    expect(session.active).toBe(true);
    expect(hooks.onStartFailed).not.toHaveBeenCalled();
    expect(hooks.onStartUnknown).not.toHaveBeenCalled();
    expect(hooks.onSnapshot.mock.calls.at(-1)![0]).toMatchObject({ session: r.token(), phase: 'joined' });
    expect(port.starts).toHaveLength(1); // 頼み直さない
  });

  it('返事の失敗のあと、読み直しで参加中（joining）なら、同じく採用したまま（消さない）', async () => {
    const { port, hooks, session } = setup();
    const r = rejectedStart(port, { snapshot: { phase: 'joining' } });
    await session.start(input);
    expect(session.session).toBe(r.token());
    expect(hooks.onStartFailed).not.toHaveBeenCalled();
    expect(hooks.onSnapshot.mock.calls.at(-1)![0]).toMatchObject({ phase: 'joining' });
  });

  it('返事の失敗のあと、読み直しも失敗したら、token を残し、「確かめられない」を一度だけ出す。停止はできる', async () => {
    const { port, hooks, session } = setup();
    const r = rejectedStart(port, { snapshot: 'fail' });
    await session.start(input);
    expect(session.session).toBe(r.token());
    expect(session.active).toBe(true);
    expect(hooks.onStartUnknown).toHaveBeenCalledTimes(1);
    expect(hooks.onStartUnknown).toHaveBeenCalledWith('ipc');
    expect(hooks.onStartFailed).not.toHaveBeenCalled();
    expect(JSON.stringify(hooks.onStartUnknown.mock.calls)).not.toContain('secret');
    // 止める手段が残っている（ネイティブへ停止を送る）
    port.snapshotError = null;
    await session.stop('user');
    expect(port.stops).toEqual([[r.token(), 'user']]);
  });

  it('読み直しが失敗したあとで、同じ論理セッションの「参加中」が届けば、画面を参加中に戻す（遅れた確かな状態）', async () => {
    const { port, hooks, session } = setup();
    const r = rejectedStart(port, { snapshot: 'fail' });
    await session.start(input);
    hooks.onSnapshot.mockClear();
    port.snapshotError = null;
    port.pushState(snap({ session: r.token(), generation: 9, seq: 5, phase: 'joined', listed: true, peer: 'p-self' }));
    expect(session.session).toBe(r.token());
    expect(hooks.onSnapshot.mock.calls.at(-1)![0]).toMatchObject({ phase: 'joined' });
    expect(hooks.onStartFailed).not.toHaveBeenCalled();
  });

  it('読み直しが失敗したあとで、同じ論理セッションが止まったと届けば、token を消す（残さない）', async () => {
    const { port, hooks, session } = setup();
    const r = rejectedStart(port, { snapshot: 'fail' });
    await session.start(input);
    port.snapshotError = null;
    port.pushState(snap({ session: null, generation: 9, seq: 6, phase: 'idle' }));
    expect(session.session).toBe(null);
    expect(hooks.onSnapshot.mock.calls.at(-1)![0]).toMatchObject({ phase: 'idle' });
    expect(port.stops).toHaveLength(0);
    expect(r.token()).toBeTruthy();
  });

  it('既知の拒否（マイクの許可など）で、読み直しが「参加していない」と確かめたら、token を消し、停止は送らない', async () => {
    const { port, hooks, session } = setup();
    port.startError = { code: 'mic_denied', message: '許可されていません' };
    await session.start(input);
    expect(hooks.onStartFailed).toHaveBeenCalledWith('mic_denied');
    expect(hooks.onStartUnknown).not.toHaveBeenCalled();
    expect(session.session).toBe(null);
    await session.stop('user');
    expect(port.stops).toHaveLength(0);
  });

  it('返事の失敗のあと、読み直しで別の論理セッションが参加中なら、その通話を採用する（自分の開始は消す）', async () => {
    const { port, hooks, session } = setup();
    rejectedStart(port, { snapshot: { session: 'OTHER', phase: 'joined', listed: true, peer: 'p-other' } });
    await session.start(input);
    expect(session.session).toBe('OTHER');
    expect(hooks.onStartFailed).not.toHaveBeenCalled();
    expect(hooks.onSnapshot.mock.calls.at(-1)![0]).toMatchObject({ session: 'OTHER' });
  });

  it('読み込み（開始の前の読み）が失敗したら、開始は頼まない（二重に参加しない）。返事の失敗の扱いにはならない', async () => {
    const { port, hooks, session } = setup();
    port.snapshotError = { code: 'busy', message: 'http://secret.example/x' };
    await session.start(input);
    expect(port.starts).toHaveLength(0);
    expect(hooks.onStartFailed).toHaveBeenCalledWith('state_unknown');
    expect(hooks.onStartUnknown).not.toHaveBeenCalled();
    expect(session.session).toBe(null);
  });
});
