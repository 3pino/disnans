import { api, uploadFile } from '../api';
import { prepareUpload } from '../imageCrop';
import { mentionsToText } from '../markdown';
import { authorOf } from '../author';
import type { ClientEvent } from '../protocol/ClientEvent';
import type { Message } from '../protocol/Message';
import type { ServerEvent } from '../protocol/ServerEvent';
import type { User } from '../protocol/User';
import { Socket, type SocketStatus } from '../ws';
import { wsUrl } from '../config';
import { Timeline, type OutgoingFile, type PendingMessage } from './timeline.svelte';
import { threads } from './threads.svelte';
import { ui, type ToastAvatar } from './ui.svelte';
import { notifications } from './notifications.svelte';
import { page, unread } from './unread.svelte';
import { errorText } from '../errors';
import { SEND_TEXT, emitFailureText, isRejectedSendCode, unknownReasonText } from '../sendOutcome';
import { bootChatTransport } from '../transport/boot';
import { CHAT_EVENT_TYPES, isChatEmit, type ChatEmitEvent, type ChatItem, type ChatSendEvent, type ChatTransport, type SendOutcome } from '../transport/chat';
import { replyPreviewOf } from '../reply';
import { reply } from './reply.svelte';

type Listener = (ev: ServerEvent) => void;

const MAIN = '__main__';
/** 接続できないとき、チャットを再試行する間隔（JS Socket の再接続の上限と同じ） */
const CHAT_RETRY_MS = 30_000;

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
  /** チャットの Rust 経路（null なら従来の JS 経路）。start() で1回だけ決める */
  private chat: ChatTransport | null = null;
  private chatState: 'idle' | 'starting' | 'started' | 'failed' = 'idle';
  /** Rust 経路で、いま有効な接続の世代（古い項目は捨てる） */
  private chatGeneration = 0;
  /** Rust 経路で、チャットに接続できていない（終端の失敗のあと、一定間隔で再試行する） */
  chatDown = $state(false);
  private chatRetry: ReturnType<typeof setTimeout> | null = null;
  /** この不通の間に toast 済みか（再試行のたびに toast しないため） */
  private chatToasted = false;
  /** 送信中の chat_emit の概算バイト数（bufferedAmount の近似に使う） */
  private chatEmitBytes = 0;

  get userList(): User[] {
    return Object.values(this.users).sort((a, b) => a.display_name.localeCompare(b.display_name, 'ja'));
  }

  /** 起動時に1回呼ぶ。chat を渡すと、チャットは Rust 経路（JS 接続はチャット以外に使う） */
  start(chat: ChatTransport | null = bootChatTransport()): void {
    if (this.socket) return;
    page.init();
    this.socket = new Socket({
      url: wsUrl,
      onEvent: (ev) => this.onSocketEvent(ev),
      onStatus: (s) => {
        // Rust 経路のときバナーの状態はチャット接続から決める（onChatItem）
        if (this.chat) return;
        this.status = s;
        if (s === 'closed') for (const t of this.timelines.values()) t.markSentUnknown();
      },
    });
    this.socket.start();
    if (chat) {
      this.chat = chat;
      void this.startChat();
    }
  }

  reconnect(): void {
    this.socket?.reconnectNow();
    if (!this.chat) return;
    if (this.chatState === 'started') void this.chat.reconnect().catch((e) => this.chatFailed(e));
    else if (this.chatState !== 'starting') {
      this.clearChatRetry();
      void this.startChat();
    }
  }

  /** 生のサーバーイベントを購読する（プラグインのホストが使う） */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  send(ev: ClientEvent): boolean {
    // Rust 経路のメッセージ送信は ChatTransport からだけ出す（JS のキューに積まない）
    if (this.chat && ev.type === 'message.send') {
      void this.sendRawChat(ev);
      return true;
    }
    // Rust 経路の編集・削除・リアクション・スレッド作成も、ChatTransport（chat_emit）からだけ出す
    if (this.chat && isChatEmit(ev)) {
      void this.emitChat(this.chat, ev);
      return true;
    }
    if (!this.socket) return false;
    return this.socket.send(ev);
  }

  /** chat_emit で送る。失敗は toast（自動では再送しない。押し直しは利用者） */
  private async emitChat(chat: ChatTransport, ev: ChatEmitEvent): Promise<void> {
    const size = JSON.stringify(ev).length;
    this.chatEmitBytes += size;
    try {
      await chat.emit(ev);
    } catch (e) {
      ui.toast(emitFailureText(e), 'error');
    } finally {
      this.chatEmitBytes -= size;
    }
  }

  /**
   * まだ送り出せていないバイト数（通話の映像の間引きに使う）。
   * 通話の音声は JS Socket から出るので、その bufferedAmount。Rust 経路の chat_emit は送信中のぶんを足す（概算）
   */
  get sendBuffered(): number {
    return (this.socket?.bufferedAmount ?? 0) + this.chatEmitBytes;
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

  /** 通知のもとのメッセージを送った人の見た目（読み込まれていなければ null） */
  senderOf(messageId: string | null): ToastAvatar | null {
    const m = messageId ? this.findMessage(messageId) : undefined;
    if (!m) return null;
    return { author: authorOf(m, this.users), user: this.users[m.author_id], id: m.author_id };
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
  sendMessage(opts: { threadId: string | null; body: string; files: OutgoingFile[]; startThread?: boolean; replyTo?: Message | null; silent?: boolean }): void {
    const me = this.me;
    if (!me) return;
    const clientId = `c-${Date.now().toString(36)}-${(++this.seq).toString(36)}`;
    const tl = this.timeline(opts.threadId);
    tl.addPending({
      id: clientId,
      client_id: clientId,
      author_id: me.id,
      thread_id: opts.threadId,
      reply_to: opts.replyTo?.id ?? null,
      reply_preview: opts.replyTo ? replyPreviewOf(opts.replyTo) : null,
      body: opts.body,
      attachments: [],
      reactions: [],
      created_at: Date.now(),
      edited_at: null,
      thread: null,
      card: null,
      bot: null,
      sent: false,
      failed: false,
      unknown: false,
      attachment_ids: [],
      start_thread: opts.startThread ?? false,
      silent: opts.silent ?? false,
      files: opts.files.map((f) => ({
        key: ++this.seq,
        file: f.file,
        crop: f.crop,
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
    const p = this.timeline(threadId).pending.find((x) => x.client_id === clientId);
    // 結果が分からないもの（unknown）は、二重投稿になるので再送しない
    if (!p || !p.failed || p.unknown) return;
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
          const file = await prepareUpload(f.file, f.crop);
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
      if (this.chat) {
        await this.submitChat(threadId, p);
        return;
      }
      p.sent = this.send({
        type: 'message.send',
        client_id: clientId,
        thread_id: threadId,
        body: p.body,
        attachment_ids: ids,
        start_thread: p.start_thread,
        reply_to: p.reply_to,
        silent: p.silent,
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

  // ---- チャットの Rust 経路（ステップ4 段4a・4b） ----

  private async startChat(): Promise<void> {
    const chat = this.chat;
    if (!chat) return;
    this.chatState = 'starting';
    this.status = 'connecting';
    try {
      await chat.start((item) => this.onChatItem(item));
      if (this.chatState === 'starting') this.chatState = 'started';
      this.chatDown = false;
      this.chatToasted = false;
    } catch (e) {
      this.chatFailed(e);
    }
  }

  /** 接続できない（終端の失敗を含む）。最初の1回だけ toast し、以後は CHAT_RETRY_MS ごとに再試行する */
  private chatFailed(e: unknown, prefix = 'チャットに接続できませんでした'): void {
    this.chatState = 'failed';
    this.chatDown = true;
    this.status = 'closed';
    if (!this.chatToasted) {
      this.chatToasted = true;
      ui.toast(`${prefix}: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
    this.scheduleChatRetry();
  }

  private scheduleChatRetry(): void {
    this.clearChatRetry();
    this.chatRetry = setTimeout(() => {
      this.chatRetry = null;
      if (this.chatState === 'failed') void this.startChat();
    }, CHAT_RETRY_MS);
  }

  private clearChatRetry(): void {
    if (this.chatRetry) clearTimeout(this.chatRetry);
    this.chatRetry = null;
  }

  private onChatItem(item: ChatItem): void {
    this.chatState = 'started';
    this.chatDown = false;
    this.chatToasted = false;
    this.clearChatRetry();
    switch (item.kind) {
      case 'connecting':
        this.status = 'connecting';
        break;
      case 'connected':
        this.chatGeneration = item.generation;
        this.status = 'open';
        // 接続ごとの hello と同じ扱い（読み込み直し・購読者への通知）
        this.dispatch({ type: 'hello', me: item.me, users: item.users });
        break;
      case 'event': {
        if (item.generation < this.chatGeneration) return;
        // Rust のストリームには通話・プラグインなども届くので、チャット系と error だけ使う
        if (item.event.type !== 'error' && !CHAT_EVENT_TYPES.has(item.event.type)) return;
        this.dispatch(item.event);
        break;
      }
      case 'gap':
        if (item.generation < this.chatGeneration) return;
        this.status = 'closed';
        break;
      case 'failed':
        this.chatFailed(item.reason, 'チャットの接続が止まりました');
        break;
    }
  }

  /** Rust 経路の送信。結果（SendOutcome）で仮表示を進める。送信中は busy のまま待つ */
  private async submitChat(threadId: string | null, p: PendingMessage): Promise<void> {
    const chat = this.chat;
    if (!chat) return;
    p.sent = true;
    const outcome = await chat.send({
      clientId: p.client_id,
      threadId,
      body: p.body,
      attachmentIds: p.attachment_ids,
      startThread: p.start_thread,
      replyTo: p.reply_to,
      silent: p.silent,
    });
    if (outcome.outcome === 'notSent') p.sent = false;
    this.applySendOutcome(threadId, p.client_id, outcome);
  }

  /** 送信結果を仮表示に反映する。notSent は client_id を持たないので、送った側の clientId を使う */
  private applySendOutcome(threadId: string | null, clientId: string, outcome: SendOutcome): void {
    switch (outcome.outcome) {
      case 'confirmed':
        // echo（message.created）と同じ処理。どちらが先でも結果は同じ（冪等）
        this.timeline(threadId).upsert(outcome.message, outcome.clientId);
        return;
      case 'rejected':
        this.reflectSend(outcome.clientId, true, errorText(outcome.code, outcome.message));
        return;
      case 'notSent':
        // 書込前に失敗（未接続・引数不正など）。投稿されていないので再送できる。理由がなければ既定の文言
        this.reflectSend(clientId, true, outcome.reason || SEND_TEXT.notConnected);
        return;
      case 'unknown':
        this.reflectSend(outcome.clientId, false, unknownReasonText(outcome.reason));
        return;
    }
  }

  /** 同じ client_id の状態を全 timeline へ反映する。状態が変わったときだけ toast */
  private reflectSend(clientId: string, rejected: boolean, text: string): void {
    const { state, changed } = this.settleAll(clientId, rejected);
    if (!state || !changed) return;
    ui.toast(`${state === 'failed' ? SEND_TEXT.failed : SEND_TEXT.unknownToast}: ${text}`, 'error');
  }

  private settleAll(clientId: string, rejected: boolean): { state: 'failed' | 'unknown' | null; changed: boolean } {
    let state: 'failed' | 'unknown' | null = null;
    let changed = false;
    for (const t of this.timelines.values()) {
      const before = t.sendState(clientId);
      const s = t.settleFromError(clientId, rejected);
      if (!s) continue;
      state = s;
      if (before !== s) changed = true;
    }
    return { state, changed };
  }

  /** plugin などの生の message.send。仮表示は作らず、結果が失敗なら error として購読者へ流す */
  private async sendRawChat(ev: ChatSendEvent): Promise<void> {
    const chat = this.chat;
    if (!chat) return;
    const outcome = await chat.send({
      clientId: ev.client_id,
      threadId: ev.thread_id,
      body: ev.body,
      attachmentIds: ev.attachment_ids,
      startThread: ev.start_thread,
      replyTo: ev.reply_to,
      silent: ev.silent,
    });
    if (outcome.outcome === 'confirmed') return; // 表示は echo で届く
    const code = outcome.outcome === 'rejected' ? outcome.code : outcome.outcome === 'notSent' ? SEND_TEXT.codeNotSent : SEND_TEXT.codeUnknown;
    const message = outcome.outcome === 'rejected' ? outcome.message : outcome.outcome === 'notSent' ? outcome.reason || SEND_TEXT.notConnected : unknownReasonText(outcome.reason);
    this.dispatch({ type: 'error', client_id: null, code, message });
  }

  /** JS 接続の項目。Rust 経路のときはチャット系（と hello）を捨てる（二重反映の防止） */
  private onSocketEvent(ev: ServerEvent): void {
    if (this.chat && (ev.type === 'hello' || CHAT_EVENT_TYPES.has(ev.type))) return;
    this.dispatch(ev);
  }

  // ---- イベント処理 ----

  private applyHello(me: User, list: User[]): void {
    this.me = me;
    const map: Record<string, User> = {};
    for (const u of list) map[u.id] = u;
    map[me.id] = me;
    this.users = map;
    this.ready = true;
    this.generation++;
    // 再接続時は、読み込み済みの履歴を取り直す
    for (const t of this.timelines.values()) if (t.loaded || t.error) void t.load();
    void threads.load();
    unread.me = me.id;
    void unread.load();
  }

  private dispatch(ev: ServerEvent): void {
    switch (ev.type) {
      case 'hello': {
        this.applyHello(ev.me, ev.users);
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
        for (const t of this.timelines.values()) t.setReplyPreview(m.id, replyPreviewOf(m));
        break;
      }
      case 'message.deleted': {
        const tl = this.peekTimeline(ev.thread_id);
        // 未読に数えていたものなら減らす（読み込んでいなければ投稿者が分からないので、他人のものとみなす）
        unread.onDeleted(ev.message_id, ev.thread_id, tl?.find(ev.message_id)?.author_id);
        tl?.remove(ev.message_id);
        for (const t of this.timelines.values()) t.setReplyPreview(ev.message_id, null);
        // 消えたメッセージを起点にした返信のツリーは、開いていれば閉じ、遷移の履歴からも外す
        ui.forgetPanel((p) => p.kind === 'replyTree' && p.messageId === ev.message_id);
        if (threads.get(ev.message_id) || this.timelines.has(ev.message_id)) {
          threads.remove(ev.message_id);
          unread.removeScope(ev.message_id);
          this.timelines.delete(ev.message_id);
          const id = ev.message_id;
          ui.forgetPanel((p) => (p.kind === 'thread' && p.id === id) || (p.kind === 'replyTree' && p.place === id));
        }
        reply.drop(ev.message_id);
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
        notifications.show({ title: ev.title, body, threadId: ev.thread_id, sample: ev.sample, from: this.senderOf(ev.message_id) });
        break;
      }
      case 'error': {
        const text = errorText(ev.code, ev.message);
        if (ev.client_id) {
          const { state, changed } = this.settleAll(ev.client_id, isRejectedSendCode(ev.code));
          // 送信結果と同じ失敗が二重に届いても、状態が変わったときだけ知らせる
          if (state) {
            if (changed) ui.toast(`${state === 'failed' ? SEND_TEXT.failed : SEND_TEXT.unknownToast}: ${text}`, 'error');
            break;
          }
        }
        ui.toast(text, 'error');
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
