import { api } from '../api';
import { mentionsToText } from '../markdown';
import type { ClientEvent } from '../protocol/ClientEvent';
import type { Message } from '../protocol/Message';
import type { ServerEvent } from '../protocol/ServerEvent';
import type { User } from '../protocol/User';
import type { Attachment } from '../protocol/Attachment';
import { Socket, type SocketStatus } from '../ws';
import { wsUrl } from '../config';
import { Timeline } from './timeline.svelte';
import { threads } from './threads.svelte';
import { ui } from './ui.svelte';
import { showNotification } from '../notify';
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

  /** 生のサーバーイベントを購読する（将来のプラグイン中継用） */
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

  sendMessage(opts: {
    threadId: string | null;
    body: string;
    attachments: Attachment[];
    // 近況（status）は使わない。スレッドはすべて同じ扱い
    startThread?: 'normal' | null;
  }): void {
    const me = this.me;
    if (!me) return;
    const clientId = `c-${Date.now().toString(36)}-${(++this.seq).toString(36)}`;
    const ids = opts.attachments.map((a) => a.id);
    const ev: ClientEvent = {
      type: 'message.send',
      client_id: clientId,
      thread_id: opts.threadId,
      body: opts.body,
      attachment_ids: ids,
      start_thread: opts.startThread ?? null,
    };
    const tl = this.timeline(opts.threadId);
    tl.addPending({
      id: clientId,
      client_id: clientId,
      author_id: me.id,
      thread_id: opts.threadId,
      body: opts.body,
      attachments: opts.attachments,
      reactions: [],
      created_at: Date.now(),
      edited_at: null,
      thread: null,
      sent: false,
      failed: false,
      attachment_ids: ids,
      start_thread: opts.startThread ?? null,
    });
    const sent = this.send(ev);
    const p = tl.pending.find((x) => x.client_id === clientId);
    if (p) p.sent = sent;
  }

  retry(threadId: string | null, clientId: string): void {
    const tl = this.timeline(threadId);
    const p = tl.pending.find((x) => x.client_id === clientId);
    if (!p) return;
    p.failed = false;
    p.sent = this.send({
      type: 'message.send',
      client_id: clientId,
      thread_id: p.thread_id,
      body: p.body,
      attachment_ids: p.attachment_ids,
      start_thread: p.start_thread,
    });
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
      this.send({ type: 'thread.create', root_message_id: msg.id, kind: 'normal' });
    }
    ui.openThread(msg.id);
  }

  async updateDisplayName(name: string): Promise<void> {
    const u = await api.updateMe({ display_name: name });
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
        break;
      }
      case 'message.created': {
        const m = ev.message;
        this.timeline(m.thread_id).upsert(m, ev.client_id);
        if (m.thread) threads.upsert({ root: m, info: m.thread });
        if (m.thread_id && m.author_id !== this.me?.id) {
          const open = ui.panel?.kind === 'thread' && ui.panel.id === m.thread_id;
          if (!open || document.visibilityState !== 'visible') threads.bumpUnread(m.thread_id);
        }
        break;
      }
      case 'message.updated': {
        const m = ev.message;
        this.timeline(m.thread_id).upsert(m);
        threads.updateRoot(m);
        break;
      }
      case 'message.deleted': {
        this.timeline(ev.thread_id).remove(ev.message_id);
        // 未読に数えた返信が消えた可能性があるので、1つ減らす（概算）
        if (ev.thread_id && (threads.unread[ev.thread_id] ?? 0) > 0) {
          threads.unread[ev.thread_id]--;
          if (threads.unread[ev.thread_id] === 0) threads.clearUnread(ev.thread_id);
        }
        if (threads.get(ev.message_id) || this.timelines.has(ev.message_id)) {
          threads.remove(ev.message_id);
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
        showNotification(ev.title, body, ev.thread_id, ev.message_id);
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
      case 'pong':
        break;
    }
    for (const fn of this.listeners) fn(ev);
  }
}

export const client = new Client();
