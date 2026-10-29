// テスト用の、ネイティブの通話の偽物（NativeCallPort）。本番のコードからは使わない

import type { NativeCallPort, NativeControlPatch, NativeEvent, NativePhase, NativeSnapshot, NativeStartArgs } from './native';

export function settingsOf(over: Partial<NativeSnapshot['settings']> = {}): NativeSnapshot['settings'] {
  return { micVolume: 1, outVolume: 1, limiter: true, limitDb: -3, rawInput: false, outputId: null, ...over };
}

/** 状態の見本。generation と seq は、テストごとに指定する */
export function snap(over: Partial<NativeSnapshot> & { phase?: NativePhase } = {}): NativeSnapshot {
  return {
    session: null,
    generation: 1,
    seq: 0,
    wanted: false,
    phase: 'idle',
    serverUrl: null,
    peer: null,
    members: [],
    muted: false,
    deafened: false,
    muteByDeafen: false,
    speaking: {},
    localMuted: [],
    settings: settingsOf(),
    linkUp: true,
    listed: false,
    bufferedBytes: 0,
    error: null,
    ...over,
  };
}

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 呼ばれた記録と、応答を操れる偽物のネイティブ */
export class FakeNativePort implements NativeCallPort {
  starts: NativeStartArgs[] = [];
  stops: [string, string][] = [];
  controls: [string, NativeControlPatch][] = [];
  kicks: [string, string][] = [];
  emits: [string, string, unknown][] = [];
  snapshotCalls = 0;
  /** 次の snapshot の応答 */
  current: NativeSnapshot = snap();
  /** 設定されていれば、start の応答をこれで待つ */
  startGate: Deferred<NativeSnapshot> | null = null;
  /** 設定されていれば、start は拒否する */
  startError: unknown = null;
  /** 設定されていれば、stop・snapshot・control は拒否する */
  stopError: unknown = null;
  snapshotError: unknown = null;
  /** 設定されていれば、それぞれの応答をこれで待つ */
  snapshotGate: Deferred<void> | null = null;
  controlGate: Deferred<void> | null = null;
  listenGate: Deferred<void> | null = null;
  /** 受け取り先（購読中のもの） */
  private listeners = new Set<(ev: NativeEvent) => void>();
  listenCount = 0;
  /** 外された購読の数 */
  unlistenCount = 0;

  async start(args: NativeStartArgs): Promise<NativeSnapshot> {
    this.starts.push(args);
    if (this.startError !== null) throw this.startError;
    if (this.startGate) return this.startGate.promise;
    this.current = snap({ session: args.session, generation: this.current.generation + 1, phase: 'joining', wanted: false, peer: 'p-self', serverUrl: args.serverUrl, settings: args.settings });
    return this.current;
  }
  async stop(session: string, reason: string): Promise<void> {
    this.stops.push([session, reason]);
    if (this.stopError !== null) throw this.stopError;
  }
  async snapshot(): Promise<NativeSnapshot> {
    this.snapshotCalls++;
    if (this.snapshotGate) await this.snapshotGate.promise;
    if (this.snapshotError !== null) throw this.snapshotError;
    return this.current;
  }
  async control(session: string, patch: NativeControlPatch): Promise<void> {
    this.controls.push([session, patch]);
    if (this.controlGate) await this.controlGate.promise;
  }
  async kick(session: string, peer: string): Promise<void> {
    this.kicks.push([session, peer]);
  }
  async emit(session: string, name: string, payload: unknown): Promise<void> {
    this.emits.push([session, name, payload]);
  }
  async listen(cb: (ev: NativeEvent) => void): Promise<() => void> {
    this.listenCount++;
    if (this.listenGate) await this.listenGate.promise;
    this.listeners.add(cb);
    return () => {
      this.unlistenCount++;
      this.listeners.delete(cb);
    };
  }
  /** ネイティブが状態を出した（テストから） */
  pushState(s: NativeSnapshot): void {
    this.current = s;
    for (const l of [...this.listeners]) l({ kind: 'state', snapshot: s });
  }
  /** ネイティブが中継を出した（テストから） */
  pushRelay(session: string, generation: number, seq: number, peer: string, from: string, name: string, payload: unknown): void {
    for (const l of [...this.listeners]) l({ kind: 'relay', session, generation, seq, peer, from, name, payload });
  }
}
