// Android の通話（ネイティブ所有）の、TypeScript 側の型・純粋な判断。Tauri には依存しない（テストできるように）。
// 設計: docs/design/android-call.md。マイク・再生・WebSocket・再接続はネイティブが持つ。JS は表示と操作の送信だけ。

import type { CallMember } from '../protocol/CallMember';

export type NativePhase = 'idle' | 'joining' | 'joined' | 'recovering' | 'stopping';

export type NativeSettings = {
  micVolume: number;
  outVolume: number;
  limiter: boolean;
  limitDb: number;
  rawInput: boolean;
  outputId: string | null;
};

export type NativeError = { code: string; message: string; by?: string };

/** ネイティブの状態（snapshot と state イベントの中身。JSON の形そのまま） */
export type NativeSnapshot = {
  session: string | null;
  /** このデバイスの中で単調に増える世代（再起動をまたいでも増える） */
  generation: number;
  /** 世代の中で単調に増える通し番号（メモリ上。起動のたびに 0 から） */
  seq: number;
  wanted: boolean;
  phase: NativePhase;
  serverUrl: string | null;
  peer: string | null;
  members: CallMember[];
  muted: boolean;
  deafened: boolean;
  muteByDeafen: boolean;
  /** 自分の発言は空文字のキー、相手の発言は peer をキーにする。 */
  speaking: Record<string, boolean>;
  localMuted: string[];
  settings: NativeSettings;
  linkUp: boolean;
  listed: boolean;
  bufferedBytes: number;
  error: NativeError | null;
};

export type NativeStartArgs = {
  session: string;
  serverUrl: string;
  expectedUserId: string;
  devUser?: string | null;
  status: { muted: boolean; deafened: boolean; device: string | null };
  settings: NativeSettings;
  localMuted?: string[];
};

export type NativeControlPatch = {
  muted?: boolean;
  deafened?: boolean;
  peerMute?: { peer: string; muted: boolean };
  settings?: Partial<NativeSettings>;
};

/** 非音声のカスタムイベント（プラグインの emit）の中継。音声（PCM）は JS へ届けない */
export type NativeRelay = {
  session: string;
  generation: number;
  seq: number;
  peer: string;
  from: string;
  name: string;
  payload: unknown;
};

export type NativeEvent = { kind: 'state'; snapshot: NativeSnapshot } | ({ kind: 'relay' } & NativeRelay);

/** ネイティブへの橋（本番は nativePort.ts。テストでは偽物）。すべて論理セッションの token で守る */
export interface NativeCallPort {
  /** 受け付けた snapshot を返す（参加の完了は待たない。参加は state イベントで確かめる） */
  start(args: NativeStartArgs): Promise<NativeSnapshot>;
  stop(session: string, reason: string): Promise<void>;
  /** 読むだけ。サービスやマイクを始めない */
  snapshot(): Promise<NativeSnapshot>;
  control(session: string, patch: NativeControlPatch): Promise<void>;
  kick(session: string, peer: string): Promise<void>;
  emit(session: string, name: string, payload: unknown): Promise<void>;
  /** 購読を先に始める。戻り値の関数で外す */
  listen(cb: (ev: NativeEvent) => void): Promise<() => void>;
}

/** 論理セッションの token（参加を頼む前に JS で作る。ASCII・48 文字以内） */
export function newSessionToken(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 古い状態・古い出来事を捨てる。世代が古いものは捨て、同じ世代では seq が増えたものだけ通す。
 * 世代が新しければ（再起動のあとの回復など）採用する。
 */
export class NativeGate {
  private generation = -1;
  private seq = -1;

  accept(ev: { generation: number; seq: number }): boolean {
    if (ev.generation < this.generation) return false;
    if (ev.generation === this.generation && ev.seq <= this.seq) return false;
    this.generation = ev.generation;
    this.seq = ev.seq;
    return true;
  }

  /** 読み直しの結果: 見た中で一番新しい状態より古くなければ受け付ける（同じ状態の読み直しは受け付ける） */
  acceptRead(ev: { generation: number; seq: number }): boolean {
    if (ev.generation < this.generation) return false;
    if (ev.generation === this.generation && ev.seq < this.seq) return false;
    this.generation = ev.generation;
    this.seq = ev.seq;
    return true;
  }
}

/** 参加の途中・参加中・回復中か（画面を「参加している」と見せる状態） */
export function isLive(phase: NativePhase): boolean {
  return phase === 'joining' || phase === 'joined' || phase === 'recovering';
}

/** snapshot を、画面の状態（CallStore の項目）へ写す。判断は持たない（不変条件はネイティブが守る） */
export function mirrorOf(s: NativeSnapshot): {
  joined: boolean;
  joining: boolean;
  listed: boolean;
  linkDown: boolean;
  muted: boolean;
  deafened: boolean;
  peer: string;
  localMuted: Set<string>;
  speaking: Record<string, boolean>;
} {
  const joined = s.phase === 'joined' || s.phase === 'recovering';
  return {
    joined,
    joining: s.phase === 'joining',
    listed: joined && s.listed,
    linkDown: joined && !s.linkUp,
    muted: s.muted,
    deafened: s.deafened,
    peer: s.peer ?? '',
    localMuted: new Set(s.localMuted),
    speaking: s.speaking,
  };
}
