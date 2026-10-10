import { api } from '../api';
import type { Message } from '../protocol/Message';
import { SEARCH_DEBOUNCE_MS, SEARCH_PAGE, appendOlder, chronological } from '../search';

/**
 * メッセージ検索の状態（入力欄が検索モードのあいだ、メインのタイムラインを結果に絞り込む）。
 * 入力が止まってから検索し、語が変わったら前の応答は捨てる。結果は古い順（チャットと同じ並び）で読む
 */
class MessageSearch {
  /** 入力中の語 */
  query = $state('');
  /** hits を検索した語（入力中でも、結果が来るまでは前の語のまま） */
  shown = $state('');
  /** サーバーから届いた順（新しい順） */
  private raw = $state<Message[]>([]);
  loading = $state(false);
  loadingOlder = $state(false);
  error = $state<string | null>(null);
  hasMore = $state(false);
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** 古いものが上の並び */
  readonly hits = $derived(chronological(this.raw));

  /** 検索を始めるか、まだ語がない */
  get active(): boolean {
    return this.query.trim() !== '';
  }

  /** 語を変える。止まってから検索する */
  setQuery(value: string): void {
    this.query = value;
    clearTimeout(this.timer);
    const q = value.trim();
    this.seq++;
    this.loadingOlder = false;
    this.error = null;
    if (!q) {
      this.raw = [];
      this.shown = '';
      this.hasMore = false;
      this.loading = false;
      return;
    }
    this.loading = true;
    this.timer = setTimeout(() => void this.run(q), SEARCH_DEBOUNCE_MS);
  }

  private async run(q: string): Promise<void> {
    const mine = ++this.seq;
    this.loading = true;
    this.error = null;
    try {
      const page = await api.searchMessages({ q, before: null, limit: SEARCH_PAGE });
      if (mine !== this.seq) return;
      this.shown = q;
      this.raw = page;
      this.hasMore = page.length >= SEARCH_PAGE;
    } catch (e) {
      if (mine !== this.seq) return;
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      if (mine === this.seq) this.loading = false;
    }
  }

  /** 失敗したときのやり直し */
  retry(): void {
    const q = this.query.trim();
    if (q) void this.run(q);
  }

  /** さらに古い結果を足す */
  async loadOlder(): Promise<void> {
    const oldest = this.raw.at(-1);
    if (!oldest || !this.hasMore || this.loading || this.loadingOlder || !this.shown) return;
    const mine = this.seq;
    const q = this.shown;
    this.loadingOlder = true;
    try {
      const page = await api.searchMessages({ q, before: oldest.id, limit: SEARCH_PAGE });
      if (mine !== this.seq) return;
      this.raw = appendOlder(this.raw, page);
      this.hasMore = page.length >= SEARCH_PAGE;
    } catch (e) {
      if (mine !== this.seq) return;
      this.error = e instanceof Error ? e.message : String(e);
      this.hasMore = false;
    } finally {
      if (mine === this.seq) this.loadingOlder = false;
    }
  }

  /** 検索モードを抜けるとき */
  reset(): void {
    clearTimeout(this.timer);
    this.seq++;
    this.query = '';
    this.shown = '';
    this.raw = [];
    this.loading = false;
    this.loadingOlder = false;
    this.error = null;
    this.hasMore = false;
  }
}

export const messageSearch = new MessageSearch();
