import type { CallMember } from '../protocol/CallMember';
import type { ServerEvent } from '../protocol/ServerEvent';
import type { ClientEvent } from '../protocol/ClientEvent';
import type { IconRef } from '../icons.svelte';
import type { NativeCallPort } from './native';
import type { CallSettings } from './settings.svelte';
import type { ScreenShareDeps } from './screen/types';

// 通話の公開の型（画面・プラグイン・各エンジンが共有する）。実装は store.svelte.ts（状態機械）と、
// 音声とシグナリングを持つエンジン（webEngine.ts / nativeEngine.ts）。

/** 本体から借りる機能（テストで差し替える） */
export type CallDeps = {
  send(ev: ClientEvent): void;
  meId(): string;
  nameOf(id: string): string;
  toast(text: string, kind?: 'info' | 'error'): void;
  confirm(opts: { title: string; body?: string; okLabel: string; danger?: boolean }): Promise<boolean>;
  /** 画面を切っても動き続けるための常駐（Android） */
  hold(opts: Disnans.BackgroundOptions): Promise<Disnans.BackgroundHandle>;
  /** 常駐の前景サービスを始められなかったとき（後から）呼ばれる。戻り値の関数で外す（任意） */
  onServiceFailed?(cb: () => void): () => void;
  audio: Disnans.Audio;
  settings: CallSettings;
  /** このデバイスの種類（smartphone / tablet / laptop / monitor） */
  deviceKind(): string;
  /** 通話の設定画面を開く */
  openSettings(): void;
  now(): number;
  /** WebSocket でまだ送り出せていないバイト数（無ければ 0 とみなす） */
  buffered?(): number;
  /** Android のネイティブ所有の通話の橋。あれば、参加・操作・音はすべてネイティブが行う（無ければ従来どおり WebView） */
  native?: NativeCallPort;
  /** ネイティブへ渡す接続先（参加のたびに読む） */
  serverUrl?(): string;
  /** ネイティブへ渡す開発用ユーザー（本番は null） */
  devUser?(): string | null;
  /** 本体の画面共有。音声だけの試験では省略できる。取得は明示操作まで始めない。 */
  screen?: Omit<ScreenShareDeps, 'call'>;
};

/** 画面・プラグインに見せる参加者1人分 */
export type CallParticipant = {
  peer: string;
  userId: string;
  self: boolean;
  muted: boolean;
  deafened: boolean;
  connected: boolean;
  speaking: boolean;
  /** 自分の側だけで消音している */
  localMuted: boolean;
  device: string | null;
};

/** 参加者から届いた、プラグインのデータ（call.emit） */
export type CallDataEvent = { peer: string; userId: string; payload: unknown };

/** 通話のバーに足すボタン */
export type BarButtonDef = { icon: IconRef; label: string; onClick: () => void; active?: boolean; disabled?: boolean; location?: 'both' | 'view' };
export type BarButton = BarButtonDef & { id: number };

/** 通話の画面（CallView）に、プラグインが足す領域 */
export type CallPanelDef = { label: string; order?: number };
export type CallPanelEntry = { id: number; label: string; order: number; el: HTMLElement; visible: boolean };
export type PanelState = { mounted: boolean; listeners: Set<(mounted: boolean) => void> };


export type PeerView = { speaking: boolean; localMuted: boolean };


/**
 * エンジンが読み書きする、通話の状態の窓口（実体は CallStore）。
 * 状態の持ち主は CallStore。エンジンは「音声とシグナリング」だけを持ち、状態の変更はここへ書く。
 */
export interface CallHost {
  readonly deps: CallDeps;
  members: CallMember[];
  joined: boolean;
  joining: boolean;
  listed: boolean;
  linkDown: boolean;
  muted: boolean;
  deafened: boolean;
  /** スピーカーミュートが、ミュートも一緒に入れた */
  muteByDeafen: boolean;
  peerId: string;
  peerView: Record<string, PeerView>;
  selfSpeaking: boolean;
  outputs: Disnans.AudioOutput[];
  /** 自分以外の参加者 */
  readonly others: CallMember[];
  readonly settings: CallSettings['value'];
  readonly participants: CallParticipant[];
  /** 出力先の一覧・選択 */
  readonly outputControl: { refresh(): Promise<void>; restore(): Promise<void> };
  /** 表示・通知・画面共有・変更の購読者へ、状態の変化を伝える */
  refresh(): void;
  /** 一覧に載る前に積んだ emit を、順に送る／捨てる */
  flushEmits(): void;
  dropEmits(): void;
  /** 参加者のデータ（プラグインの emit）を、画面共有と購読者へ配る */
  dispatch(name: string, event: CallDataEvent): void;
  /** 画面共有を止める */
  stopScreen(): void;
}

/**
 * 通話の音声とシグナリングの実装。デバイスごとに 1 つを、CallStore を作るときに選ぶ。
 * - WebCallEngine: WebView が参加・音声（WebAudio）・サーバーの call.* を受け持つ
 * - NativeCallEngine: Android のネイティブが参加・音・再接続を持ち、ここは状態を写すだけ
 */
export interface CallEngine {
  /** ネイティブが通話を所有する */
  readonly nativeOwned: boolean;
  join(): Promise<void>;
  leave(sendLeave: boolean, reason: string): void;
  toggleMute(): void;
  toggleDeafen(): void;
  toggleLocalMute(peer: string): void;
  kick(peer: string): void;
  /** 一覧に載ったあとの、プラグインの emit */
  emit(name: string, payload: unknown): void;
  /** WebSocket でまだ送り出せていないバイト数 */
  readonly bufferedAmount: number;
  onServerEvent(ev: ServerEvent): void;
  onLink(up: boolean): void;
  /** 起動のとき 1 回。ネイティブの通話を採用する（Web では何もしない） */
  adopt(): Promise<void>;
  /** 接続先が変わった（ネイティブだけ意味がある） */
  onServerChanged(): void;
  applyMicVolume(): void;
  applyOutVolume(): void;
  /** 定期処理（Web: 音量・生存・出力。ネイティブでは何もしない） */
  tick(): void;
  /** 出力先を参加時に戻す（Web） */
  restoreOutputs(): Promise<void>;
  /** 画面用の表示（話している人）を、エンジンの内部状態から写す。ネイティブは状態から直接入るので何もしない */
  syncView(): void;
  /** 通知の差し替え（Web の常駐のみ） */
  updateNotification(): void;
  /** プラグインのコールバックの例外を記録する */
  reportCallbackError(e: unknown): void;
  /** 状態機械が壊れるときの片付け */
  dispose?(): void;
}
