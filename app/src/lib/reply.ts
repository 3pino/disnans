/** 返信まわりの補助 */
import type { Message } from './protocol/Message';
import type { ReplyPreview } from './protocol/ReplyPreview';

/** 返信先の要約に入れる本文の最大文字数（サーバーと同じ） */
const PREVIEW_CHARS = 100;

/** メッセージから返信先の要約を作る（送信中の仮表示で、サーバーの要約の代わりに使う） */
export function replyPreviewOf(m: Pick<Message, 'author_id' | 'body' | 'attachments' | 'bot'>): ReplyPreview {
  const text = m.body.split(/\s+/).filter(Boolean).join(' ');
  return {
    author_id: m.author_id,
    body: text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) + '…' : text,
    has_attachments: m.attachments.length > 0,
    bot: m.bot,
  };
}
