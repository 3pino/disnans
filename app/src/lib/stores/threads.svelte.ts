import { api } from '../api';
import type { Message } from '../protocol/Message';
import type { Thread } from '../protocol/Thread';

function activity(t: Thread): number {
  return t.info.last_reply_at ?? t.root.created_at;
}

class Threads {
  list = $state<Thread[]>([]);
  loaded = $state(false);

  async load(): Promise<void> {
    try {
      const list = await api.threads();
      this.list = list.sort((a, b) => activity(b) - activity(a));
      this.loaded = true;
    } catch {
      // 再接続時にまた取る
    }
  }

  get(id: string): Thread | undefined {
    return this.list.find((t) => t.root.id === id);
  }

  upsert(t: Thread): void {
    const rest = this.list.filter((x) => x.root.id !== t.root.id);
    rest.push(t);
    this.list = rest.sort((a, b) => activity(b) - activity(a));
  }

  remove(id: string): void {
    this.list = this.list.filter((t) => t.root.id !== id);
  }

  /** 起点のメッセージが更新されたとき */
  updateRoot(msg: Message): void {
    const t = this.get(msg.id);
    if (t) t.root = msg;
  }
}

export const threads = new Threads();
