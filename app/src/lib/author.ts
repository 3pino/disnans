/**
 * メッセージの投稿者の見た目（名前・アイコン）の決め方。
 * ボットのメッセージ（`message.bot`）は、`author_id` が実行した人でも、ボットとして表示する。
 */
import type { Message } from './protocol/Message';
import type { User } from './protocol/User';

export type AuthorView = {
  name: string;
  /** アイコンの URL。なければ（呼び出し側がイニシャルなどで描く）null */
  avatarUrl: string | null;
  isBot: boolean;
  /** ボットなら、投稿したプラグインの ID */
  botPlugin?: string;
};

type MessageLike = Pick<Message, 'author_id' | 'bot'>;

/**
 * 投稿者の表示用の情報。ボットなら名前はボットの名前、アイコンは `pluginIconUrl(プラグイン ID)`
 * （渡さない・null を返すなら null）。人なら表示名とアバター。
 */
export function authorOf(
  message: MessageLike,
  usersById: ReadonlyMap<string, User> | Record<string, User | undefined>,
  pluginIconUrl?: (pluginId: string) => string | null | undefined,
): AuthorView {
  if (message.bot) {
    return {
      name: message.bot.name,
      avatarUrl: pluginIconUrl?.(message.bot.plugin) ?? null,
      isBot: true,
      botPlugin: message.bot.plugin,
    };
  }
  const user = usersById instanceof Map ? usersById.get(message.author_id) : (usersById as Record<string, User | undefined>)[message.author_id];
  return {
    name: user?.display_name ?? '不明なユーザー',
    avatarUrl: user?.avatar_url ?? null,
    isBot: false,
  };
}

/** 自分の発言として扱うか（右寄せ・編集可能などの見た目用）。ボットの発言は、自分が実行したものでも含めない */
export function isOwnMessage(message: MessageLike, myId: string | null | undefined): boolean {
  return !!myId && message.author_id === myId && !message.bot;
}
