import type { Session as SessionData } from '../protocol/Session';
import type { User } from '../protocol/User';
import { avatarSrc } from '../config';
import { errorMessage, isVersionConflict, type Cleanup, type HostServices } from './types';

/** Session.update がぶつかったときのエラー（disnans.VersionConflictError） */
export class VersionConflictError extends Error {
  constructor(message = 'ほかの人の更新とぶつかりました') {
    super(message);
    this.name = 'VersionConflictError';
  }
}

type EventListener = (payload: unknown, from: Disnans.User) => void;

/** session.event の from に使う（いないユーザー） */
function unknownUser(id: string): Disnans.User {
  return { id, login_name: '', display_name: '不明なユーザー', avatar_url: null };
}

function toPluginUser(u: User): Disnans.User {
  // avatar_url はサーバーからの相対パス（/api/avatars/...）のことがあるので、そのまま使える URL にする
  return { id: u.id, login_name: u.login_name, display_name: u.display_name, avatar_url: u.avatar_url ? avatarSrc(u.avatar_url) : null };
}

/**
 * プラグインから見たセッション。1つのプラグイン（の読み込み1回分）の中では、同じ id なら同じオブジェクト。
 * プラグインを外すと、購読（onChange / on）はまとめて捨てる。
 */
export class SessionImpl implements Disnans.Session<unknown> {
  readonly id: string;
  readonly plugin: string;
  readonly createdBy: string;
  readonly messageId: string;
  state: unknown;
  version: number;
  card: Disnans.Card;

  private changeListeners = new Set<(s: Disnans.Session<unknown>) => void>();
  private eventListeners = new Map<string, Set<EventListener>>();
  /** 外したあと（メッセージの削除・プラグインの解除）は何もしない */
  disposed = false;

  constructor(
    data: SessionData,
    private services: HostServices,
  ) {
    this.id = data.id;
    this.plugin = data.plugin;
    this.createdBy = data.created_by;
    this.messageId = data.message_id;
    this.state = data.state;
    this.version = data.version;
    this.card = { ...data.card };
  }

  /**
   * サーバーの最新を取り込む。今より新しいときだけ反映し、onChange を呼ぶ。
   * 自分の update の応答と、それに続いて届く session.updated で二重に呼ばないよう、version で見分ける。
   */
  apply(data: SessionData): boolean {
    if (this.disposed || data.version <= this.version) return false;
    this.state = data.state;
    this.version = data.version;
    this.card = { ...data.card };
    for (const cb of [...this.changeListeners]) {
      try {
        cb(this);
      } catch (e) {
        console.error(`[plugin:${this.plugin}] onChange で例外`, e);
      }
    }
    return true;
  }

  /** session.event を受け取ったとき */
  dispatchEvent(name: string, payload: unknown, fromId: string): void {
    if (this.disposed) return;
    const set = this.eventListeners.get(name);
    if (!set) return;
    const u = this.services.app.user(fromId);
    const from = u ?? unknownUser(fromId);
    for (const cb of [...set]) {
      try {
        cb(payload, from);
      } catch (e) {
        console.error(`[plugin:${this.plugin}] on('${name}') で例外`, e);
      }
    }
  }

  async update(state: unknown, opts?: { card?: Disnans.Card }): Promise<void> {
    if (this.disposed) throw new Error('このセッションはもう使えません');
    let data: SessionData;
    try {
      data = await this.services.api.updateSession(this.id, {
        version: this.version,
        state,
        card: opts?.card ? { title: opts.card.title, text: opts.card.text } : null,
      });
    } catch (e) {
      if (!isVersionConflict(e)) throw e;
      // ぶつかった: 最新を読み直してから知らせる（プラグインは session.state で考え直す）
      try {
        this.apply(await this.services.api.getSession(this.id));
      } catch (e2) {
        console.error(`[plugin:${this.plugin}] セッションを読み直せませんでした: ${errorMessage(e2)}`);
      }
      throw new VersionConflictError();
    }
    this.apply(data);
  }

  onChange(cb: (session: Disnans.Session<unknown>) => void): Cleanup {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  emit(name: string, payload?: unknown): void {
    if (this.disposed) return;
    this.services.send({ type: 'session.emit', session_id: this.id, name, payload: payload ?? null });
  }

  on(name: string, cb: EventListener): Cleanup {
    let set = this.eventListeners.get(name);
    if (!set) {
      set = new Set();
      this.eventListeners.set(name, set);
    }
    set.add(cb);
    return () => set.delete(cb);
  }

  dispose(): void {
    this.disposed = true;
    this.changeListeners.clear();
    this.eventListeners.clear();
  }
}

/** プラグイン1つ分の this.sessions */
export class SessionsImpl implements Disnans.Sessions {
  private cache = new Map<string, SessionImpl>();
  /** 読み込み中の get（同じ id を同時に読んでも1つにまとめる） */
  private loading = new Map<string, Promise<SessionImpl>>();

  constructor(
    private pluginId: string,
    private services: HostServices,
  ) {}

  private adopt(data: SessionData): SessionImpl {
    const cur = this.cache.get(data.id);
    if (cur) {
      cur.apply(data);
      return cur;
    }
    const s = new SessionImpl(data, this.services);
    this.cache.set(data.id, s);
    return s;
  }

  async create<S = unknown>(opts: { state: S; card: Disnans.Card; threadId?: string | null }): Promise<Disnans.Session<S>> {
    const data = await this.services.api.createSession({
      plugin: this.pluginId,
      thread_id: opts.threadId ?? null,
      state: opts.state,
      card: { title: opts.card.title, text: opts.card.text },
    });
    return this.adopt(data) as Disnans.Session<S>;
  }

  async get<S = unknown>(id: string): Promise<Disnans.Session<S>> {
    const cur = this.cache.get(id);
    if (cur) return cur as Disnans.Session<S>;
    let p = this.loading.get(id);
    if (!p) {
      p = this.services.api.getSession(id).then((data) => this.adopt(data));
      this.loading.set(id, p);
      void p.finally(() => this.loading.delete(id)).catch(() => {});
    }
    return (await p) as Disnans.Session<S>;
  }

  /** 読み込み済みのものだけ返す */
  peek(id: string): SessionImpl | undefined {
    return this.cache.get(id);
  }

  /** session.updated */
  applyUpdate(data: SessionData): void {
    this.cache.get(data.id)?.apply(data);
  }

  /** session.event */
  dispatchEvent(sessionId: string, name: string, payload: unknown, from: string): void {
    this.cache.get(sessionId)?.dispatchEvent(name, payload, from);
  }

  /** カードのメッセージが消えた（セッションも消えた）。消えたセッションの id を返す */
  dropByMessage(messageId: string): string[] {
    const ids: string[] = [];
    for (const [id, s] of this.cache) {
      if (s.messageId === messageId) {
        s.dispose();
        this.cache.delete(id);
        ids.push(id);
      }
    }
    return ids;
  }

  dispose(): void {
    for (const s of this.cache.values()) s.dispose();
    this.cache.clear();
  }
}

export { toPluginUser };
