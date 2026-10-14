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
  threadId: string | null;
  body: string;
  attachmentIds: string[];
  startThread: boolean;
  replyTo: string | null;
  silent: boolean;
};

/**
 * Rust の chat_emit で送る書込（契約 §8.6）。サーバーは ack を返さない。
 * 通話の join / leave / update / kick は含めない: サーバーは通話の参加者を「送った接続」で覚えていて、
 * 音声（call.emit）はその接続から出す必要がある。音声は JS Socket のままなので、参加も JS Socket に残す。
 */
export type ChatEmitEvent = Extract<
  ClientEvent,
  {
    type:
      | 'message.edit'
      | 'message.delete'
      | 'reaction.add'
      | 'reaction.remove'
      | 'thread.create'
      | 'session.emit'
      | 'plugin.emit';
  }
>;

const CHAT_EMIT_TYPES: ReadonlySet<string> = new Set([
  'message.edit',
  'message.delete',
  'reaction.add',
  'reaction.remove',
  'thread.create',
  'session.emit',
  'plugin.emit',
]);

/** この書込がチャット（Rust）経路で送るものか */
export function isChatEmit(ev: ClientEvent): ev is ChatEmitEvent {
  return CHAT_EMIT_TYPES.has(ev.type);
}

/** chat_emit の reject（契約 §8.6。ApiBridgeError と違い status は無い） */
export type ChatCommandError = { code: 'not_connected' | 'write_failed' | 'send_not_allowed' | 'invalid_request'; message: string };

export interface ChatTransport {
  /** 最初の接続が成功するまで返らない（失敗は reject。その場合セッションは作られていない）。失敗のあとに呼び直してよい */
  start(onItem: (item: ChatItem) => void): Promise<void>;
  /** 結果は必ず SendOutcome で返る（reject しない。書込前の失敗は notSent） */
  send(draft: MessageDraft): Promise<SendOutcome>;
  /** 編集・削除・リアクション・スレッド作成。成功は書込んだこと（反映は後から event で届く）。失敗は ChatCommandError で reject */
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
  'thread.updated',
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
]);
// 通話（call.*）は JS Socket だけで受け取る（参加者の登録がその接続にあるため。上の ChatEmitEvent の注釈を参照）

/** plugin 送信 / 通話などの生の ClientEvent から、チャット系の送信だけを取り出す */
export type ChatSendEvent = Extract<ClientEvent, { type: 'message.send' }>;
