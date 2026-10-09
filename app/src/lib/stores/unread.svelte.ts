import { api } from '../api';
import type { MarkRead } from '../protocol/MarkRead';
import type { Message } from '../protocol/Message';
import type { ReadMarker } from '../protocol/ReadMarker';

/**
 * 未読の管理（SPEC 3.1「既読・未読」）。
 *
 * 場所（メインチャットかスレッド1つ）ごとに「ここまで読んだ位置」（メッセージ ID）と未読数を持つ。
 * 位置はサーバーに保存し、同じユーザーの端末どうしで共有する（`GET/PUT /api/me/read`、`read.updated`）。
 * ID（ULID）は作成順に並ぶので、文字列の大小で前後を比べる。
 */

/** メインチャットのキー（スレッドはスレッドの ID） */
export const MAIN_KEY = '';

export function scopeKey(threadId: string | null): string {
  return threadId ?? MAIN_KEY;
}

function threadIdOf(key: string): string | null {
  return key === MAIN_KEY ? null : key;
}

/** 既読を送るまで待つ時間。スクロールしながら読むときに、まとめて1回にする */
export const MARK_DEBOUNCE_MS = 800;

/** 未読の最初のメッセージ（位置より新しい、他人のメッセージ）。なければ null */
export function firstUnread(messages: readonly Message[], cursor: string | undefined, me: string | null): Message | null {
  for (const m of messages) {
    if (m.author_id === me) continue;
    if (cursor === undefined || m.id > cursor) return m;
  }
  return null;
}

/**
 * 次（`dir = 1`）・前（`dir = -1`）の未読のある場所。`order` はメインチャットとスレッドを並べたキー、
 * `current` はいま見ている場所。いまの場所の次から順にたどり、一周しても見つからなければ null
 * （いまの場所だけに未読があるときは、いまの場所を返す）。
 */
export function nextUnreadKey(order: readonly string[], counts: Readonly<Record<string, number>>, current: string, dir: 1 | -1 = 1): string | null {
  const n = order.length;
  if (n === 0) return null;
  const start = order.indexOf(current);
  for (let step = 1; step <= n; step++) {
    // current が order になければ、先頭（dir=1）か末尾（dir=-1）から始める
    const i = start === -1 ? (dir === 1 ? step - 1 : n - step) : (((start + dir * step) % n) + n) % n;
    if ((counts[order[i]] ?? 0) > 0) return order[i];
  }
  return null;
}

export type UnreadDeps = {
  /** 既読の位置をサーバーに送る */
  send: (body: MarkRead) => Promise<unknown>;
  /** 既読の位置と未読数を取る */
  fetch: () => Promise<ReadMarker[]>;
};

export class Unread {
  /** キー → 未読数（0 のキーは持たない） */
  counts = $state<Record<string, number>>({});
  /** キー → ここまで読んだ位置。知らない場所（読み込み後にできたスレッドなど）は持たない */
  cursors = $state<Record<string, string>>({});
  /** 一度でもサーバーから読み込んだか */
  loaded = $state(false);
  /** 自分のユーザー ID（自分のメッセージは未読に数えない） */
  me: string | null = null;

  /** まだ送っていない既読の位置（キー → ID） */
  private outgoing = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private deps: UnreadDeps) {}

  get main(): number {
    return this.counts[MAIN_KEY] ?? 0;
  }

  /** スレッドの未読の合計 */
  get threadTotal(): number {
    let sum = 0;
    for (const [k, v] of Object.entries(this.counts)) if (k !== MAIN_KEY) sum += v;
    return sum;
  }

  count(threadId: string | null): number {
    return this.counts[scopeKey(threadId)] ?? 0;
  }

  cursor(threadId: string | null): string | undefined {
    return this.cursors[scopeKey(threadId)];
  }

  /** 接続・再接続のたびに呼ぶ。サーバーの値で置き換える */
  async load(): Promise<void> {
    try {
      this.applyAll(await this.deps.fetch());
    } catch (e) {
      // 再接続時にまた取る
      console.warn('未読を読み込めませんでした', e);
    }
  }

  /** サーバーから取った一覧で置き換える。まだ送っていない既読の位置は残す */
  applyAll(list: readonly ReadMarker[]): void {
    const counts: Record<string, number> = {};
    const cursors: Record<string, string> = {};
    for (const m of list) {
      const key = scopeKey(m.thread_id);
      cursors[key] = m.last_read_id;
      if (m.unread_count > 0) counts[key] = m.unread_count;
    }
    for (const [key, id] of this.outgoing) {
      if (cursors[key] === undefined || id > cursors[key]) {
        cursors[key] = id;
        delete counts[key];
      }
    }
    this.counts = counts;
    this.cursors = cursors;
    this.loaded = true;
  }

  /** `read.updated`（自分の別の端末、またはこの端末で送った既読）。手元より進んでいるときだけ使う */
  applyRemote(m: ReadMarker): void {
    const key = scopeKey(m.thread_id);
    const local = this.cursors[key];
    const waiting = this.outgoing.get(key);
    if (local !== undefined && m.last_read_id < local) return;
    // 手元でもっと先まで読んでいて、まだ送っていなければ、その結果を待つ
    if (waiting !== undefined && m.last_read_id < waiting) return;
    this.cursors[key] = m.last_read_id;
    this.setCount(key, m.unread_count);
  }

  /** 新しいメッセージが届いた */
  onMessage(m: Message): void {
    if (m.author_id === this.me) return;
    const key = scopeKey(m.thread_id);
    const cursor = this.cursors[key];
    if (cursor !== undefined && m.id <= cursor) return;
    this.setCount(key, (this.counts[key] ?? 0) + 1);
  }

  /**
   * メッセージが消えた。未読に数えていたものなら減らす。
   * `authorId` は手元に読み込んでいれば分かる（分からなければ他人のものとして扱う）。
   */
  onDeleted(messageId: string, threadId: string | null, authorId: string | undefined): void {
    if (authorId !== undefined && authorId === this.me) return;
    const key = scopeKey(threadId);
    const cursor = this.cursors[key];
    if (cursor !== undefined && messageId <= cursor) return;
    const n = this.counts[key] ?? 0;
    if (n > 0) this.setCount(key, n - 1);
  }

  /** スレッドが消えた */
  removeScope(threadId: string): void {
    delete this.counts[threadId];
    delete this.cursors[threadId];
    this.outgoing.delete(threadId);
  }

  /**
   * `latestId` まで読んだ（その場所の最新のメッセージが見えている）。未読を 0 にし、少し待ってからサーバーに送る。
   * いまの位置より古ければ、未読数だけ 0 にする（送らない）。
   */
  markRead(threadId: string | null, latestId: string): void {
    const key = scopeKey(threadId);
    const cursor = this.cursors[key];
    if (this.counts[key]) this.setCount(key, 0);
    if (cursor !== undefined && latestId <= cursor) return;
    this.cursors[key] = latestId;
    this.outgoing.set(key, latestId);
    this.schedule();
  }

  /** まだ送っていない既読をすぐに送る（アプリが裏に回るときなど） */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const items = [...this.outgoing];
    this.outgoing.clear();
    for (const [key, id] of items) {
      this.deps.send({ thread_id: threadIdOf(key), message_id: id }).catch((e) => {
        // 消えたスレッドなど。次に読んだときにまた送る
        console.warn('既読を送れませんでした', e);
      });
    }
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, MARK_DEBOUNCE_MS);
  }

  private setCount(key: string, n: number): void {
    if (n > 0) this.counts[key] = n;
    else if (key in this.counts) delete this.counts[key];
  }
}

export const unread = new Unread({
  send: (body) => api.markRead(body),
  fetch: () => api.readMarkers(),
});

// ---- 見ているかどうか ----

class PageActivity {
  /** 画面が表示されていて、ウィンドウにフォーカスがある（既読にしてよい） */
  active = $state(true);
  /** 画面が表示されている（区切り線の位置を決め直す目安） */
  visible = $state(true);

  init(): void {
    if (typeof document === 'undefined') return;
    const update = () => {
      this.visible = document.visibilityState === 'visible';
      this.active = this.visible && document.hasFocus();
      // 裏に回るときは、まだ送っていない既読をすぐに送る
      if (!this.visible) unread.flush();
    };
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    update();
  }
}

export const page = new PageActivity();

// ---- 表示中のメッセージ一覧（MessageList）とのやりとり ----

export type UnreadView = {
  /** 未読の最初（区切り線）までスクロールする。未読がなければ一番下へ。スクロールしたら true */
  scrollToFirstUnread: () => boolean;
};

const views = new Map<string, UnreadView>();
/** 開いたあと、表示されたら最初の未読までスクロールする場所 */
let pendingJump: string | null = null;

/** MessageList が表示中に登録する。戻り値で解除する */
export function registerUnreadView(threadId: string | null, view: UnreadView): () => void {
  const key = scopeKey(threadId);
  views.set(key, view);
  return () => {
    if (views.get(key) === view) views.delete(key);
  };
}

/** MessageList が表示されて読み込み終わったときに呼ぶ。開くときに頼まれていれば true（最初の未読までスクロールする） */
export function takePendingJump(threadId: string | null): boolean {
  if (pendingJump !== scopeKey(threadId)) return false;
  pendingJump = null;
  return true;
}

/** 開いたあとで最初の未読までスクロールするよう頼む（表示中ならすぐにスクロールする） */
export function requestJump(threadId: string | null): void {
  const key = scopeKey(threadId);
  const view = views.get(key);
  if (view && view.scrollToFirstUnread()) {
    pendingJump = null;
    return;
  }
  pendingJump = key;
}
