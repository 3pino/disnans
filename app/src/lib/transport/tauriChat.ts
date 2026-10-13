import { toBridgeError } from './tauri';
import type { ChatItem, ChatTransport, MessageDraft, SendOutcome } from './chat';
import type { BridgeContext, Invoke } from './types';

/** Tauri の Channel と同じ形（テストでは差し替える） */
export type ChannelLike<T> = { onmessage: (item: T) => void };

/** `@tauri-apps/api/core` の Channel（遅延 import。Tauri 以外では呼ばれない） */
async function defaultChannel(): Promise<ChannelLike<ChatItem>> {
  const { Channel } = await import('@tauri-apps/api/core');
  return new Channel<ChatItem>();
}

/**
 * チャットの Tauri 実装（契約 §8.3）。
 * `send` は reject しない: 書込前の失敗は notSent として返す（ChatSession の規則と同じ）。
 */
export function createTauriChatTransport(
  invoke: Invoke,
  ctx: BridgeContext,
  makeChannel: () => Promise<ChannelLike<ChatItem>> = defaultChannel,
): ChatTransport {
  return {
    async start(onItem) {
      const onItemChannel = await makeChannel();
      onItemChannel.onmessage = onItem;
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
        return { outcome: 'notSent', reason: toBridgeError(e).message };
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
      try {
        await invoke('chat_stop');
      } catch (e) {
        throw toBridgeError(e);
      }
    },
  };
}
