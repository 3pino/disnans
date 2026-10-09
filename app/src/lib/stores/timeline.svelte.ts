import { api } from '../api';
import type { Message } from '../protocol/Message';
import type { Reaction } from '../protocol/Reaction';

/** 送信中（仮表示）のメッセージ */
export type PendingMessage = Message & {
  client_id: string;
  /** サーバーに送った（キューではない） */
  sent: boolean;
  failed: boolean;
  /** 再送用 */
  attachment_ids: string[];
  start_thread: boolean;
};

const PAGE = 50;

/** メインチャット、またはスレッド1つ分のメッセージ */
export class Timeline {
  messages = $state<Message[]>([]);
  pending = $state<PendingMessage[]>([]);
  loaded = $state(false);
  loading = $state(false);
  loadingOlder = $state(false);
  hasMore = $state(true);
  error = $state<string | null>(null);

  constructor(public readonly threadId: string | null) {}

  /** 最新のページを取り、手元と突き合わせる（初回・再接続時） */
  async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.error = null;
    try {
      const page = await api.messages({ threadId: this.threadId, limit: PAGE });
      this.mergeLatest(page);
      if (!this.loaded) this.hasMore = page.length >= PAGE;
      this.loaded = true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loading = false;
    }
  }

  private mergeLatest(page: Message[]): void {
    if (page.length === 0) {
      this.messages = [];
      this.hasMore = false;
      return;
    }
    const oldest = page[0].id;
    const newestLocal = this.messages.at(-1)?.id;
    if (!newestLocal || newestLocal < oldest) {
      // 間が空いたので、最新ページで置き換える
      this.messages = page;
      this.hasMore = page.length >= PAGE;
      return;
    }
    // oldest より新しい範囲はサーバーの内容で置き換える（削除・編集を反映）
    const keep = this.messages.filter((m) => m.id < oldest);
    this.messages = [...keep, ...page];
  }

  async loadOlder(): Promise<void> {
    if (this.loadingOlder || !this.hasMore || !this.loaded) return;
    const before = this.messages[0]?.id;
    if (!before) return;
    this.loadingOlder = true;
    try {
      const page = await api.messages({ threadId: this.threadId, before, limit: PAGE });
      const ids = new Set(this.messages.map((m) => m.id));
      this.messages = [...page.filter((m) => !ids.has(m.id)), ...this.messages];
      this.hasMore = page.length >= PAGE;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loadingOlder = false;
    }
  }

  find(id: string): Message | undefined {
    return this.messages.find((m) => m.id === id);
  }

  /** 作成・更新。ID 順に挿入する */
  upsert(msg: Message, clientId?: string | null): void {
    if (clientId) this.pending = this.pending.filter((p) => p.client_id !== clientId);
    const idx = this.messages.findIndex((m) => m.id === msg.id);
    if (idx !== -1) {
      this.messages[idx] = msg;
      return;
    }
    if (!this.loaded) return; // 読み込み時に取れる
    // 読み込んだ範囲より古いものは、さかのぼったときに取れる
    if (this.hasMore && this.messages.length > 0 && msg.id < this.messages[0].id) return;
    let i = this.messages.length;
    while (i > 0 && this.messages[i - 1].id > msg.id) i--;
    this.messages.splice(i, 0, msg);
  }

  remove(id: string): void {
    this.messages = this.messages.filter((m) => m.id !== id);
  }

  patch(id: string, fn: (m: Message) => void): void {
    const m = this.messages.find((x) => x.id === id);
    if (m) fn(m);
  }

  setReactions(id: string, reactions: Reaction[]): void {
    this.patch(id, (m) => {
      m.reactions = reactions;
    });
  }

  addPending(p: PendingMessage): void {
    this.pending.push(p);
  }

  failPending(clientId: string): boolean {
    const p = this.pending.find((x) => x.client_id === clientId);
    if (p) p.failed = true;
    return !!p;
  }

  /** 送信済みで確定していないものは、切断で結果が分からなくなるので失敗扱いにする */
  failSentPending(): void {
    for (const p of this.pending) if (p.sent) p.failed = true;
  }

  discardPending(clientId: string): void {
    this.pending = this.pending.filter((p) => p.client_id !== clientId);
  }
}
