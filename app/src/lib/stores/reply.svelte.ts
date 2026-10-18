import type { Message } from '../protocol/Message';

/** 入力欄の「返信先」（メインチャットに1つ。送ったら外す） */
class ReplyTarget {
  private target = $state<Message | null>(null);

  get(): Message | null {
    return this.target;
  }

  set(message: Message): void {
    this.target = message;
  }

  clear(): void {
    this.target = null;
  }

  /** メッセージが削除されたら、それを返信先にしている入力欄から外す */
  drop(messageId: string): void {
    if (this.target?.id === messageId) this.target = null;
  }
}

export const reply = new ReplyTarget();
