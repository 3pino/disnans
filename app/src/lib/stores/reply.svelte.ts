import type { Message } from '../protocol/Message';

const MAIN = '__main__';

/** 入力欄の「返信先」。メインチャットとスレッドごとに1つ持つ（送ったら外す） */
class ReplyTargets {
  private targets = $state<Record<string, Message>>({});

  get(threadId: string | null): Message | null {
    return this.targets[threadId ?? MAIN] ?? null;
  }

  set(threadId: string | null, message: Message): void {
    this.targets[threadId ?? MAIN] = message;
  }

  clear(threadId: string | null): void {
    delete this.targets[threadId ?? MAIN];
  }

  /** メッセージが削除されたら、それを返信先にしている入力欄から外す */
  drop(messageId: string): void {
    for (const [k, m] of Object.entries(this.targets)) if (m.id === messageId) delete this.targets[k];
  }
}

export const reply = new ReplyTargets();
