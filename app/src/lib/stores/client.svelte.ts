import { api, uploadFile } from '../api';
import { prepareUpload } from '../imageResize';
import { mentionsToText } from '../markdown';
import type { ClientEvent } from '../protocol/ClientEvent';
import type { Message } from '../protocol/Message';
import type { ServerEvent } from '../protocol/ServerEvent';
import type { User } from '../protocol/User';
import { Socket, type SocketStatus } from '../ws';
import { wsUrl } from '../config';
import { Timeline, type OutgoingFile } from './timeline.svelte';
import { threads } from './threads.svelte';
import { ui } from './ui.svelte';
import { notifications } from './notifications.svelte';
import { page, unread } from './unread.svelte';
import { errorText } from '../errors';

type Listener = (ev: ServerEvent) => void;

const MAIN = '__main__';

class Client {
  me = $state<User | null>(null);
  users = $state<Record<string, User>>({});
  status = $state<SocketStatus>('connecting');
  /** 最初の hello を受け取ったか */
  ready = $state(false);
  /** 何度目の接続か（再接続の判定用） */
  generation = $state(0);

  private socket: Socket | null = null;
  private timelines = new Map<string, Timeline>();
  private listeners = new Set<Listener>();
  private seq = 0;

  get userList(): User[] {
    return Object.values(this.users).sort((a, b) => a.display_name.localeCompare(b.display_name, 'ja'));
  }

  start(): void {
    if (this.socket) return;
    page.init();
    this.socket = new Socket({
      url: wsUrl,
      onEvent: (ev) => this.dispatch(ev),
      onStatus: (s) => {
        this.status = s;
        if (s === 'closed') for (const t of this.timelines.values()) t.failSentPending();
      },
    });
    this.socket.start();
  }

  reconnect(): void {
    this.socket?.reconnectNow();
  }

  /** 生のサーバーイベントを購読する（プラグインのホストが使う） */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  send(ev: ClientEvent): boolean {
    if (!this.socket) return false;
    return this.socket.send(ev);
  }

  timeline(threadId: string | null): Timeline {
    const key = threadId ?? MAIN;
    let t = this.timelines.get(key);
    if (!t) {
      t = new Timeline(threadId);
      this.timelines.set(key, t);
    }
    return t;
  }

  peekTimeline(threadId: string | null): Timeline | undefined {
    return this.timelines.get(threadId ?? MAIN);
  }

  user(id: string): User | undefined {
    return this.users[id];
  }

  nameOf(id: string): string {
    return this.users[id]?.display_name ?? '不明なユーザー';
  }

  /** どこかに読み込まれているメッセージを探す */
  findMessage(id: string): Message | undefined {
    for (const t of this.timelines.values()) {
      const m = t.find(id);
      if (m) return m;
    }
    return threads.get(id)?.root;
  }

  // ---- 操作 ----

  /**
   * メッセージを送る。添付は送るときにアップロードし、そのあとでメッセージを送る（送信中は仮表示）。
   * 失敗したら仮表示を「送信できませんでした」にして、再送・取り消しに任せる
   */
  sendMessage(opts: { threadId: string | null; body: string; files: OutgoingFile[]; startThread?: boolean }): void {
    const me = this.me;
    if (!me) return;
    const clientId = `c-${Date.now().toString(36)}-${(++this.seq).toString(36)}`;
    const tl = this.timeline(opts.threadId);
    tl.addPending({
      id: clientId,
      client_id: clientId,
      author_id: me.id,
      thread_id: opts.threadId,
      body: opts.body,
      attachments: [],
      reactions: [],
      created_at: Date.now(),
      edited_at: null,
      thread: null,
      card: null,
      sent: false,
      failed: false,
      attachment_ids: [],
      start_thread: opts.startThread ?? false,
      files: opts.files.map((f) => ({
        key: ++this.seq,
        file: f.file,
        maxEdge: f.maxEdge,
        preview: f.file.type.startsWith('image/') ? URL.createObjectURL(f.file) : null,
        progress: 0,
        attachment: null,
        error: null,
        abort: null,
      })),
      busy: false,
    });
    void this.deliver(opts.threadId, clientId);
  }

  /** 送信できなかったものを、もう一度送る（アップロード済みのファイルは上げ直さない） */
  retry(threadId: string | null, clientId: string): void {
    void this.deliver(threadId, clientId);
  }

  /**
   * 仮表示のメッセージを先へ進める: まだ上げていないファイルを順に上げ、そろったらメッセージを送る。
   * 失敗したところで止め、failed にする（同じ操作をもう一度すれば続きから）
   */
  private async deliver(threadId: string | null, clientId: string): Promise<void> {
    const tl = this.timeline(threadId);
    const find = () => tl.pending.find((x) => x.client_id === clientId);
    const p = find();
    if (!p || p.busy) return;
    p.busy = true;
    p.failed = false;
    try {
      for (const f of p.files) {
        if (f.attachment) continue;
        f.error = null;
        try {
          const file = await prepareUpload(f.file, f.maxEdge);
          if (!find()) return; // 取り消された
          const h = uploadFile(file, (r) => (f.progress = r));
          f.progress = 0;
          f.abort = h.abort;
          f.attachment = await h.promise;
          f.progress = 1;
        } catch (e) {
          f.abort = null;
          if (!find()) return; // 取り消したときの中止は、失敗として扱わない
          f.error = e instanceof Error ? e.message : String(e);
          p.failed = true;
          ui.toast(`送信できませんでした: ${f.error}`, 'error');
          return;
        }
        f.abort = null;
        p.attachments = p.files.flatMap((x) => (x.attachment ? [x.attachment] : []));
      }
      if (!find()) return;
      const ids = p.files.flatMap((x) => (x.attachment ? [x.attachment.id] : []));
      p.attachment_ids = ids;
      p.attachments = p.files.flatMap((x) => (x.attachment ? [x.attachment] : []));
      p.sent = this.send({
        type: 'message.send',
        client_id: clientId,
        thread_id: threadId,
        body: p.body,
        attachment_ids: ids,
        start_thread: p.start_thread,
      });
    } finally {
      p.busy = false;
    }
  }

  editMessage(msg: Message, body: string): void {
    this.timeline(msg.thread_id).patch(msg.id, (m) => {
      m.body = body;
      m.edited_at = Date.now();
    });
    this.send({ type: 'message.edit', message_id: msg.id, body });
  }

  deleteMessage(msg: Message): void {
    this.send({ type: 'message.delete', message_id: msg.id });
  }

  toggleReaction(msg: Message, emoji: string): void {
    const me = this.me;
    if (!me) return;
    const mine = msg.reactions.find((r) => r.emoji === emoji)?.user_ids.includes(me.id);
    this.send({ type: mine ? 'reaction.remove' : 'reaction.add', message_id: msg.id, emoji });
  }

  /** メッセージからスレッドを開く（なければ作る） */
  openThreadFrom(msg: Message): void {
    if (!msg.thread) {
      this.send({ type: 'thread.create', root_message_id: msg.id });
    }
    ui.openThread(msg.id);
  }

  async updateDisplayName(name: string): Promise<void> {
    const u = await api.updateMe({ display_name: name });
    this.me = u;
    this.users[u.id] = u;
  }

  /** 自分のアバターを画像にする */
  async setAvatar(file: File): Promise<void> {
    const u = await api.setAvatar(file, file.name);
    this.me = u;
    this.users[u.id] = u;
  }

  /** 自分で設定したアバターを消し、Tailscale のプロフィール画像に戻す */
  async clearAvatar(): Promise<void> {
    const u = await api.clearAvatar();
    this.me = u;
    this.users[u.id] = u;
  }

  // ---- イベント処理 ----

  private dispatch(ev: ServerEvent): void {
    switch (ev.type) {
      case 'hello': {
        this.me = ev.me;
        const map: Record<string, User> = {};
        for (const u of ev.users) map[u.id] = u;
        map[ev.me.id] = ev.me;
        this.users = map;
        this.ready = true;
        this.generation++;
        // 再接続時は、読み込み済みの履歴を取り直す
        for (const t of this.timelines.values()) if (t.loaded || t.error) void t.load();
        void threads.load();
        unread.me = ev.me.id;
        void unread.load();
        break;
      }
      case 'message.created': {
        const m = ev.message;
        this.timeline(m.thread_id).upsert(m, ev.client_id);
        if (m.thread) threads.upsert({ root: m, info: m.thread });
        // 自分のものは数えない。見ている場所なら、MessageList がすぐに既読にする
        unread.onMessage(m);
        break;
      }
      case 'message.updated': {
        const m = ev.message;
        this.timeline(m.thread_id).upsert(m);
        threads.updateRoot(m);
        break;
      }
      case 'message.deleted': {
        const tl = this.peekTimeline(ev.thread_id);
        // 未読に数えていたものなら減らす（読み込んでいなければ投稿者が分からないので、他人のものとみなす）
        unread.onDeleted(ev.message_id, ev.thread_id, tl?.find(ev.message_id)?.author_id);
        tl?.remove(ev.message_id);
        if (threads.get(ev.message_id) || this.timelines.has(ev.message_id)) {
          threads.remove(ev.message_id);
          unread.removeScope(ev.message_id);
          this.timelines.delete(ev.message_id);
          if (ui.panel?.kind === 'thread' && ui.panel.id === ev.message_id) ui.closePanel();
        }
        break;
      }
      case 'thread.updated': {
        threads.upsert(ev.thread);
        // 起点のメッセージの thread 情報も更新する
        const root = ev.thread.root;
        this.timeline(root.thread_id).upsert(root);
        break;
      }
      case 'reaction.updated': {
        for (const t of this.timelines.values()) t.setReactions(ev.message_id, ev.reactions);
        const t = threads.get(ev.message_id);
        if (t) t.root.reactions = ev.reactions;
        break;
      }
      case 'user.updated': {
        this.users[ev.user.id] = ev.user;
        if (this.me?.id === ev.user.id) this.me = ev.user;
        break;
      }
      case 'notify': {
        const body = mentionsToText(ev.body, (id) => this.nameOf(id));
        notifications.show({ title: ev.title, body, threadId: ev.thread_id, sample: ev.sample });
        break;
      }
      case 'error': {
        let handled = false;
        if (ev.client_id) {
          for (const t of this.timelines.values()) handled = t.failPending(ev.client_id) || handled;
        }
        const text = errorText(ev.code, ev.message);
        ui.toast(handled ? `送信できませんでした: ${text}` : text, 'error');
        break;
      }
      case 'plugin.updated':
      case 'plugin.removed':
      case 'session.updated':
      case 'session.event':
      case 'plugin.event':
        // プラグインのホスト（lib/plugins/host.svelte.ts）が subscribe で受け取る
        break;
      case 'prefs.updated':
        // 設定（lib/stores/prefs.svelte.ts）が subscribe で受け取る
        break;
      case 'read.updated':
        unread.applyRemote(ev.marker);
        break;
      case 'pong':
        break;
    }
    for (const fn of this.listeners) fn(ev);
  }
}

export const client = new Client();
