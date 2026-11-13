/** 一覧に載る前の plugin の emit を待たせる上限（件数と時間。超えたら捨てる） */
const EMIT_QUEUE_MAX = 50;
const EMIT_QUEUE_MS = 5000;

/** 参加を送ったが、まだサーバーの一覧に載っていないあいだの emit を積む。載ったら順に送る */
export class EmitQueue {
  private queue: { name: string; payload: unknown }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** 積む。上限を超えたものは捨てる（例外にはしない） */
  push(name: string, payload: unknown): void {
    if (this.queue.length >= EMIT_QUEUE_MAX) {
      console.warn(`[call] 一覧に載るまでの送信が多いので捨てました: name=${name}`);
      return;
    }
    this.queue.push({ name, payload });
    this.timer ??= setTimeout(() => {
      this.timer = null;
      if (this.queue.length === 0) return;
      console.warn(`[call] 一覧に載らないまま ${this.queue.length} 件の送信を捨てました`);
      this.queue = [];
    }, EMIT_QUEUE_MS);
  }

  /** 一覧に載ったら、積んだ emit を順に渡す */
  flush(send: (name: string, payload: unknown) => void): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const q = this.queue;
    this.queue = [];
    for (const e of q) send(e.name, e.payload);
  }

  drop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
  }
}
