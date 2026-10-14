import { toBridgeError } from './tauri';
import { SEND_TEXT } from '../sendOutcome';
import type { ChatItem, ChatTransport, MessageDraft, SendOutcome } from './chat';
import type { ApiBridgeError, BridgeContext, Invoke } from './types';

/** Tauri の Channel と同じ形（テストでは差し替える） */
export type ChannelLike<T> = { onmessage: (item: T) => void; toJSON?: () => string };

/** `@tauri-apps/api/core` の Channel（遅延 import。Tauri 以外では呼ばれない） */
export async function defaultChannel<T>(): Promise<ChannelLike<T>> {
  const { Channel } = await import('@tauri-apps/api/core');
  return new Channel<T>();
}

/**
 * `chat_send` の reject を SendOutcome にする。
 * Rust の `ReadFailure`（{code, message}）で拒否されたのは、Rust が書込む前に止めたとき（引数不正など）だけなので notSent。
 * それ以外（IPC の失敗、コマンド不在など）は書込んだかどうか分からないので、安全側に unknown（再送しない）。
 */
export function sendRejection(e: unknown, clientId: string): SendOutcome {
  if (isBridgeError(e)) return { outcome: 'notSent', reason: e.message };
  return { outcome: 'unknown', clientId, reason: { kind: 'serverError', code: 'bridge_error', message: SEND_TEXT.reasonBridge } };
}

function isBridgeError(e: unknown): e is ApiBridgeError {
  if (!e || typeof e !== 'object' || e instanceof Error) return false;
  const b = e as Partial<ApiBridgeError>;
  return typeof b.code === 'string' && typeof b.message === 'string';
}

/**
 * チャットの Tauri 実装（契約 §8.3）。
 * `send` は reject しない（上の sendRejection で結果にする）。
 */
export function createTauriChatTransport(
  invoke: Invoke,
  ctx: BridgeContext,
  makeChannel: () => Promise<ChannelLike<ChatItem>> = defaultChannel,
): ChatTransport {
  // start のたびに進める。古い Channel に残った項目（IPC で遅れて届く分）は捨てる。
  // 世代は ChatSession ごとに 1 から振り直されるので、接続の世代では区別できない。
  let startSeq = 0;
  return {
    async start(onItem) {
      const mine = ++startSeq;
      const onItemChannel = await makeChannel();
      onItemChannel.onmessage = (item) => {
        if (mine === startSeq) onItem(item);
      };
      try {
        await invoke('chat_start', { args: { server: ctx.server(), devUser: ctx.devUser, onItem: onItemChannel } });
      } catch (e) {
        throw toBridgeError(e);
      }
    },
    async send(draft: MessageDraft): Promise<SendOutcome> {
      try {
        return await invoke<SendOutcome>('chat_send', { draft });
      } catch (e) {
        return sendRejection(e, draft.clientId);
      }
    },
    async reconnect() {
      try {
        await invoke('chat_reconnect');
      } catch (e) {
        throw toBridgeError(e);
      }
    },
    async stop() {
      startSeq++; // 停止後は、それまでの Channel の項目を捨てる
      try {
        await invoke('chat_stop');
      } catch (e) {
        throw toBridgeError(e);
      }
    },
  };
}
