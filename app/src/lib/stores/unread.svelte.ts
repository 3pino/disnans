import { api } from '../api';
import type { MarkRead } from '../protocol/MarkRead';
import type { Message } from '../protocol/Message';
import type { ReadMarker } from '../protocol/ReadMarker';

/**
 * 未読の管理（SPEC 3.1「既読・未読」）。
 *
 * メインチャットの「ここまで読んだ位置」（メッセージ ID）と未読数を持つ（スレッドは廃止した）。
 * 位置はサーバーに保存し、同じユーザーの端末どうしで共有する（`GET/PUT /api/me/read`、`read.updated`）。
 * ID（ULID）は作成順に並ぶので、文字列の大小で前後を比べる。
 * サーバーから来る `thread_id` は無視する（すべてメインチャットとして扱う）。
 */

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

export type UnreadDeps = {
  /** 既読の位置をサーバーに送る */
  send: (body: MarkRead) => Promise<unknown>;
  /** 既読の位置と未読数を取る */
  fetch: () => Promise<ReadMarker[]>;
};

export class Unread {
  /** 未読数（0 は持たない） */
  count = $state(0);
  /** ここまで読んだ位置（まだ読み込んでいなければ undefined） */
  cursor = $state<string | undefined>(undefined);
  /** 一度でもサーバーから読み込んだか */
  loaded = $state(false);
  /** 自分のユーザー ID（自分のメッセージは未読に数えない） */
  me: string | null = null;

  /** まだ送っていない既読の位置 */
  private outgoing: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private deps: UnreadDeps) {}

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
    // thread_id は無視する（すべてメインチャットの位置として扱う）。複数あれば後のものを使う
    let cursor: string | undefined;
    let count = 0;
    for (const m of list) {
      cursor = m.last_read_id;
      count = m.unread_count > 0 ? m.unread_count : 0;
    }
    if (this.outgoing !== null && (cursor === undefined || this.outgoing > cursor)) {
      cursor = this.outgoing;
      count = 0;
    }
    this.count = count;
    this.cursor = cursor;
    this.loaded = true;
  }

  /** `read.updated`（自分の別の端末、またはこの端末で送った既読）。手元より進んでいるときだけ使う */
  applyRemote(m: ReadMarker): void {
    if (this.cursor !== undefined && m.last_read_id < this.cursor) return;
    // 手元でもっと先まで読んでいて、まだ送っていなければ、その結果を待つ
    if (this.outgoing !== null && m.last_read_id < this.outgoing) return;
    this.cursor = m.last_read_id;
    this.setCount(m.unread_count);
  }

  /** 新しいメッセージが届いた */
  onMessage(m: Message): void {
    if (m.author_id === this.me) return;
    if (this.cursor !== undefined && m.id <= this.cursor) return;
    this.setCount(this.count + 1);
  }

  /**
   * メッセージが消えた。未読に数えていたものなら減らす。
   * `authorId` は手元に読み込んでいれば分かる（分からなければ他人のものとして扱う）。
   */
  onDeleted(messageId: string, authorId: string | undefined): void {
    if (authorId !== undefined && authorId === this.me) return;
    if (this.cursor !== undefined && messageId <= this.cursor) return;
    if (this.count > 0) this.setCount(this.count - 1);
  }

  /**
   * `latestId` まで読んだ（最新のメッセージが見えている）。未読を 0 にし、少し待ってからサーバーに送る。
   * いまの位置より古ければ、未読数だけ 0 にする（送らない）。
   */
  markRead(latestId: string): void {
    const cursor = this.cursor;
    if (this.count) this.setCount(0);
    if (cursor !== undefined && latestId <= cursor) return;
    this.cursor = latestId;
    this.outgoing = latestId;
    this.schedule();
  }

  /** まだ送っていない既読をすぐに送る（アプリが裏に回るときなど） */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const id = this.outgoing;
    this.outgoing = null;
    if (id === null) return;
    this.deps.send({ message_id: id }).catch((e) => {
      // 次に読んだときにまた送る
      console.warn('既読を送れませんでした', e);
    });
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, MARK_DEBOUNCE_MS);
  }

  private setCount(n: number): void {
    this.count = n > 0 ? n : 0;
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

let view: UnreadView | null = null;
/** 開いたあと、表示されたら最初の未読までスクロールする */
let pendingJump = false;

/** MessageList が表示中に登録する。戻り値で解除する */
export function registerUnreadView(next: UnreadView): () => void {
  view = next;
  return () => {
    if (view === next) view = null;
  };
}

/** MessageList が表示されて読み込み終わったときに呼ぶ。開くときに頼まれていれば true（最初の未読までスクロールする） */
export function takePendingJump(): boolean {
  if (!pendingJump) return false;
  pendingJump = false;
  return true;
}

/** 最初の未読までスクロールするよう頼む（表示中ならすぐにスクロールする） */
export function requestJump(): void {
  if (view && view.scrollToFirstUnread()) {
    pendingJump = false;
    return;
  }
  pendingJump = true;
}
