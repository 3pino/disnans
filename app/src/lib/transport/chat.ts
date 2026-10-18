import type { ClientEvent } from '../protocol/ClientEvent';
import type { Message } from '../protocol/Message';
import type { ServerEvent } from '../protocol/ServerEvent';
import type { User } from '../protocol/User';

/**
 * チャット WS の Rust 経路（ステップ4 段4）。契約は .pi/step4-ipc-contract.md §8。
 * 実装は Tauri（tauriChat.ts）だけ。HTTP/JS 経路は従来の Socket のまま。
 */

/** Rust のチャット接続が JS へ流す項目（Tauri Channel。順序は保証される） */
export type ChatItem =
  | { kind: 'connecting'; attempt: number }
  | { kind: 'connected'; generation: number; me: User; users: User[] }
  | { kind: 'event'; generation: number; event: ServerEvent }
  | { kind: 'gap'; generation: number; reason: string }
  | { kind: 'failed'; reason: string; httpStatus: number | null };

export type UnknownReason =
  | { kind: 'disconnected' }
  | { kind: 'timeout' }
  | { kind: 'writeFailed' }
  | { kind: 'serverError'; code: string; message: string };

/** 送信の結果（ChatSession の SendOutcome と1対1） */
export type SendOutcome =
  | { outcome: 'confirmed'; clientId: string; message: Message }
  | { outcome: 'rejected'; clientId: string; code: string; message: string }
  | { outcome: 'unknown'; clientId: string; reason: UnknownReason }
  | { outcome: 'notSent'; reason: string };

export type MessageDraft = {
  clientId: string;
  body: string;
  attachmentIds: string[];
  replyTo: string | null;
  silent: boolean;
};

/**
 * Rust の chat_emit で送る書込（契約 §8.6）。サーバーは ack を返さない。
 * 通話（参加・退出・状態・キック・音声）も含む: 通話の参加者はサーバーが「送った接続」で覚えるので、
 * 通話の送信はすべて同じ Rust 接続から出す（デスクトップでは JS Socket を作らない）。
 */
export type ChatEmitEvent = Extract<
  ClientEvent,
  {
    type:
      | 'message.edit'
      | 'message.delete'
      | 'reaction.add'
      | 'reaction.remove'
      | 'session.emit'
      | 'plugin.emit'
      | 'call.join'
      | 'call.leave'
      | 'call.update'
      | 'call.kick'
      | 'call.emit';
  }
>;

const CHAT_EMIT_TYPES: ReadonlySet<string> = new Set([
  'message.edit',
  'message.delete',
  'reaction.add',
  'reaction.remove',
  'session.emit',
  'plugin.emit',
  'call.join',
  'call.leave',
  'call.update',
  'call.kick',
  'call.emit',
]);

/** この書込がチャット（Rust）経路で送るものか */
export function isChatEmit(ev: ClientEvent): ev is ChatEmitEvent {
  return CHAT_EMIT_TYPES.has(ev.type);
}

/** chat_emit の reject（契約 §8.6。ApiBridgeError と違い status は無い） */
export type ChatCommandError = {
  code: 'not_connected' | 'write_failed' | 'send_not_allowed' | 'invalid_request' | 'busy';
  message: string;
};

/** 通話の制御（join / leave / update / kick）。並行に投げると順序が保証されないので、直列にする（契約 §8.6） */
export const CALL_CONTROL_TYPES: ReadonlySet<string> = new Set(['call.join', 'call.leave', 'call.update', 'call.kick']);

export interface ChatTransport {
  /** 最初の接続が成功するまで返らない（失敗は reject。その場合セッションは作られていない）。失敗のあとに呼び直してよい */
  start(onItem: (item: ChatItem) => void): Promise<void>;
  /** 結果は必ず SendOutcome で返る（reject しない。書込前の失敗は notSent） */
  send(draft: MessageDraft): Promise<SendOutcome>;
  /** 編集・削除・リアクション。成功は書込んだこと（反映は後から event で届く）。失敗は ChatCommandError で reject */
  emit(event: ChatEmitEvent): Promise<void>;
  /** 切断中なら待たずに再接続する */
  reconnect(): Promise<void>;
  stop(): Promise<void>;
}

/** チャットのサーバーイベント（Rust のストリームが正。JS 接続からは捨てる。hello は別扱い） */
export const CHAT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'message.created',
  'message.updated',
  'message.deleted',
  'reaction.updated',
  'user.updated',
  'notify',
  'read.updated',
  // セッション・プラグイン・設定（送信は chat_emit。受信は Rust の stream が正）
  'session.updated',
  'session.event',
  'plugin.updated',
  'plugin.removed',
  'plugin.event',
  'prefs.updated',
  'call.state',
  'call.event',
  'call.kicked',
]);

/** plugin 送信 / 通話などの生の ClientEvent から、チャット系の送信だけを取り出す */
export type ChatSendEvent = Extract<ClientEvent, { type: 'message.send' }>;
