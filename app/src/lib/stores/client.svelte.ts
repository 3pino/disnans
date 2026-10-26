import { api } from '../api';
import { mentionsToText, setTree } from '../markdown';
import { markdownTreeOf } from '../transport/markdownTree';
import { authorOf } from '../author';
import type { ClientEvent } from '../protocol/ClientEvent';
import type { Message } from '../protocol/Message';
import type { ServerEvent } from '../protocol/ServerEvent';
import type { User } from '../protocol/User';
import { Socket, type SocketStatus } from '../ws';
import { wsUrl } from '../config';
import { isAndroid, isTauri } from '../platform';
import { Timeline, type PendingMessage } from './timeline.svelte';
import { ui, type ToastAvatar } from './ui.svelte';
import { notifications } from './notifications.svelte';
import { page, unread } from './unread.svelte';
import { errorText } from '../errors';
import { SEND_TEXT, describeEmitError, emitFailureText, isRejectedSendCode, unknownReasonText } from '../sendOutcome';
import { bootChatTransport } from '../transport/boot';
import { failureReason } from '../connection';
import { CALL_CONTROL_TYPES, CHAT_EVENT_TYPES, isChatEmit, type ChatEmitEvent, type ChatItem, type ChatSendEvent, type ChatTransport, type SendOutcome } from '../transport/chat';
import { replyPreviewOf } from '../reply';
import { reply } from './reply.svelte';
import { resumeReconnect } from './chatResume';
import { EV_AUDIO } from '../call/pure';
import { AUDIO_MAX_IN_FLIGHT, callLatency } from '../call/latency';
import { sharedIndex } from './sharedIndex.svelte';
import { viewTexts } from '../viewTexts';

type Listener = (ev: ServerEvent) => void;

/** 添付の変更を読み直すまでの待ち（ms） */
const ATTACHMENT_REFRESH_MS = 300;

/** 接続できないとき、チャットを再試行する間隔（JS Socket の再接続の上限と同じ） */
const CHAT_RETRY_MS = 30_000;

/** 通話の音声（call.emit の audio）か */
function isAudioEmit(ev: ChatEmitEvent): boolean {
  return ev.type === 'call.emit' && ev.name === EV_AUDIO;
}

/** 失敗の code（Rust の {code,message}。分からなければ unknown） */
function errorCodeOf(e: unknown): string {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : 'unknown';
}

/** 通話の操作のエラー。画面の toast は通話の状態が出す（ここでは出さない） */
const CALL_ERROR_CODES: ReadonlySet<string> = new Set(['not_in_call', 'peer_in_use', 'invalid_peer', 'invalid_status', 'ws_only']);

/** chat_emit が失敗しても toast しない種類（通話の音声・状態、プレゼンス） */
const SILENT_EMIT_FAILURES: ReadonlySet<string> = new Set(['call.emit', 'call.alive', 'call.update', 'session.open', 'session.close']);

class Client {
  me = $state<User | null>(null);
  users = $state<Record<string, User>>({});
  status = $state<SocketStatus>('connecting');
  /** つながらない原因の 1 行（接続バナーの診断用）。つながったら消す */
  linkReason = $state<string | null>(null);
  /** 最初の hello を受け取ったか */
  ready = $state(false);
  /** 何度目の接続か（再接続の判定用） */
  generation = $state(0);

  private socket: Socket | null = null;
  /** メインチャットの履歴 */
  private readonly main = new Timeline();
  private listeners = new Set<Listener>();
  private seq = 0;
  /** チャットの Rust 経路（null なら従来の JS 経路）。start() で1回だけ決める */
  private chat: ChatTransport | null = null;
  private chatState: 'idle' | 'starting' | 'started' | 'failed' = 'idle';
  /** Rust 経路で、いま有効な接続の世代（古い項目は捨てる） */
  private chatGeneration = 0;
  /** 添付の変更を、短い間にまとめて読み直すための時計（アップロードが続いても 1 回で済ませる） */
  private attachmentTimer: ReturnType<typeof setTimeout> | null = null;
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

  /** 起動時に1回呼ぶ。chat を渡すと、チャットは Rust 経路。Tauri の Windows・Linux・Android は必ず渡す（S7）。JS Socket はブラウザーだけ */
  start(chat: ChatTransport | null = bootChatTransport()): void {
    if (this.socket || this.chat) return;
    page.init();
    // Rust 経路（Windows・Linux・Android）では JS Socket を作らない。接続・ping・再接続・通話の送受信はすべて chat 側
    if (chat) {
      this.chat = chat;
      void this.startChat();
      // Android（rust チャット。既定）: ネットワークが変わったら、接続を作り直す。背景から戻ったときは、
      // 背景が長かったか・接続が切れていたときだけ作り直す（resumeReconnect。S2）。
      // chat_reconnect は接続中に何もしないので、chat_start（強制の作り直し）を使う。新しい接続の hello で履歴も読み直す
      if (isTauri() && isAndroid() && typeof window !== 'undefined') {
        window.addEventListener('online', () => this.restartChat());
        document.addEventListener('visibilitychange', () => this.onVisibilityChanged());
      }
      return;
    }
    this.socket = new Socket({
      url: wsUrl,
      onEvent: (ev) => this.dispatch(ev),
      onStatus: (s) => {
        this.setLink(s);
        if (s === 'closed') {
          this.linkReason = 'WebSocket が応答しません（接続できない・切れた）';
          this.main.markSentUnknown();
        }
      },
    });
    this.socket.start();
  }

  /** 接続の状態（バナーなど）。open / 切れた の変化を購読者（通話など）へ知らせる */
  subscribeLink(fn: (up: boolean) => void): () => void {
    this.linkListeners.add(fn);
    return () => this.linkListeners.delete(fn);
  }

  private setLink(s: SocketStatus): void {
    if (s === 'open') this.linkReason = null;
    if (this.status === s) return;
    this.status = s;
    for (const fn of this.linkListeners) fn(s === 'open');
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

  private linkListeners = new Set<(up: boolean) => void>();

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
      if (CALL_CONTROL_TYPES.has(ev.type)) {
        // 通話の制御は前の結果を待ってから次を送る（並行だと順序が保証されない）。失敗は emitChat 内で処理済み
        const chat = this.chat;
        this.callControl = this.callControl.then(() => this.emitChat(chat, ev));
      } else if (isAudioEmit(ev)) {
        // 音声は返事を待たずに送るが、返事の来ていないものが溜まったら新しいほうを捨てる（溜めると遅れが積み上がる）
        if (this.audioInflight >= AUDIO_MAX_IN_FLIGHT) {
          callLatency.count('捨てた音声');
          return true;
        }
        void this.emitChat(this.chat, ev);
      } else {
        void this.emitChat(this.chat, ev);
      }
      return true;
    }
    if (!this.socket) return false;
    return this.socket.send(ev);
  }

  /**
   * chat_emit で送る。失敗は toast（自動では再送しない。押し直しは利用者）。
   * 音声（call.emit）と通話の状態（call.update）は、切れているあいだ黙って捨てる（毎回 toast すると邪魔になる）。
   * 取りこぼしは許容（通話の音声は遅れて届くより捨てる）。
   */
  /** 通話の制御の直列化用（直前の送信の完了を待つ鎖。emitChat は reject しない） */
  private callControl: Promise<void> = Promise.resolve();

  /** まだ返事の来ていない音声（call.emit）の数 */
  private audioInflight = 0;

  private async emitChat(chat: ChatTransport, ev: ChatEmitEvent): Promise<void> {
    const size = JSON.stringify(ev).length;
    this.chatEmitBytes += size;
    const audio = isAudioEmit(ev);
    const t0 = performance.now();
    if (audio) {
      this.audioInflight += 1;
      callLatency.gauge('同時に送信中', this.audioInflight);
    }
    try {
      await chat.emit(ev);
      if (audio) callLatency.add('送信の往復', performance.now() - t0);
    } catch (e) {
      if (audio) {
        // 音声は 1 件ずつ警告しない（毎回出すと Console が埋まる）。集計に code を残す
        callLatency.fail(errorCodeOf(e));
      } else {
        // 診断: どの操作が、どの種別・code で失敗したか（通話の不具合の切り分け用）
        console.warn(`[chat] chat_emit 失敗: type=${ev.type} ${describeEmitError(e)}`);
        // プレゼンス（session.open / close）も黙る。接続し直しのときに開き直すので、利用者の操作は要らない
        if (!SILENT_EMIT_FAILURES.has(ev.type)) ui.toast(emitFailureText(e), 'error');
      }
    } finally {
      this.chatEmitBytes -= size;
      if (audio) this.audioInflight -= 1;
    }
  }

  /**
   * まだ送り出せていないバイト数（通話の映像の間引きに使う）。
   * Rust 経路（デスクトップ・Android）では、送信中の chat_emit のバイト数だけ（JS Socket を使わない。S5）。
   * ブラウザーの開発用 Socket のときは、その bufferedAmount を足す
   */
  get sendBuffered(): number {
    if (this.chat) return this.chatEmitBytes;
    return (this.socket?.bufferedAmount ?? 0) + this.chatEmitBytes;
  }

  timeline(): Timeline {
    return this.main;
  }

  user(id: string): User | undefined {
    return this.users[id];
  }

  nameOf(id: string): string {
    return this.users[id]?.display_name ?? viewTexts.unknownUser;
  }

  /** 通知のもとのメッセージを送った人の見た目（読み込まれていなければ null） */
  senderOf(messageId: string | null): ToastAvatar | null {
    const m = messageId ? this.findMessage(messageId) : undefined;
    if (!m) return null;
    return { author: authorOf(m, this.users), user: this.users[m.author_id], id: m.author_id };
  }

  /** 読み込まれているメッセージを探す */
  findMessage(id: string): Message | undefined {
    return this.main.find(id);
  }

  // ---- 操作 ----

  /**
   * メッセージを送る。添付は送るときにアップロードし、そのあとでメッセージを送る（送信中は仮表示）。
   * 失敗したら仮表示を「送信できませんでした」にして、再送・取り消しに任せる
   */
  /**
   * メッセージを送る（仮表示を出して、送信する）。添付は入力欄で先に上げて本文に埋め込んであるので、ここでは本文だけを送る。
   */
  sendMessage(opts: { body: string; replyTo?: Message | null; silent?: boolean }): void {
    const me = this.me;
    if (!me) return;
    const clientId = `c-${Date.now().toString(36)}-${(++this.seq).toString(36)}`;
    const body = opts.body;
    this.main.addPending({
      id: clientId,
      client_id: clientId,
      author_id: me.id,
      reply_to: opts.replyTo?.id ?? null,
      reply_preview: opts.replyTo ? replyPreviewOf(opts.replyTo) : null,
      body,
      attachments: [],
      reactions: [],
      created_at: Date.now(),
      edited_at: null,
      card: null,
      bot: null,
      sent: false,
      failed: false,
      unknown: false,
      attachment_ids: [],
      silent: opts.silent ?? false,
      busy: false,
    });
    // 本文の木は Rust に作らせて付ける。返るまでは、同じ本文をプレーンに描く
    void markdownTreeOf(body).then((tree) => {
      const p = this.main.pending.find((x) => x.client_id === clientId);
      if (tree && p && p.body === body) p.markdown = tree;
    });
    void this.deliver(clientId);
  }

  /** 送信できなかったものを、もう一度送る */
  retry(clientId: string): void {
    const p = this.main.pending.find((x) => x.client_id === clientId);
    // 結果が分からないもの（unknown）は、二重投稿になるので再送しない
    if (!p || !p.failed || p.unknown) return;
    void this.deliver(clientId);
  }

  /** 仮表示のメッセージを送る（失敗したら failed にする。同じ操作をもう一度すれば送り直す） */
  private async deliver(clientId: string): Promise<void> {
    const find = () => this.main.pending.find((x) => x.client_id === clientId);
    const p = find();
    if (!p || p.busy) return;
    p.busy = true;
    p.failed = false;
    try {
      if (this.chat) {
        await this.submitChat(p);
        return;
      }
      p.sent = this.send({
        type: 'message.send',
        client_id: clientId,
        body: p.body,
        attachment_ids: [],
        reply_to: p.reply_to,
        silent: p.silent,
      });
    } finally {
      p.busy = false;
    }
  }

  editMessage(msg: Message, body: string): void {
    // 古い木は捨てる（返るまではプレーン）。届いた木は、同じ本文のときだけ付ける
    this.main.patch(msg.id, (m) => {
      m.body = body;
      m.edited_at = Date.now();
      setTree(m, undefined);
    });
    void markdownTreeOf(body).then((tree) => {
      if (!tree) return;
      this.main.patch(msg.id, (m) => {
        if (m.body === body) setTree(m, tree);
      });
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
    this.setLink('connecting');
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
    this.linkReason = failureReason(e);
    this.chatState = 'failed';
    this.chatDown = true;
    this.setLink('closed');
    if (!this.chatToasted) {
      this.chatToasted = true;
      ui.toast(`${prefix}: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
    this.scheduleChatRetry();
  }

  /** 背景に回った時刻（戻ったときに、背景にいた時間を測る） */
  private hiddenAt: number | null = null;
  /** 通話に参加しているか（通話の側が教える。背景からの復帰で接続を作り直さないため） */
  private inCall: () => boolean = () => false;

  /** 通話に参加しているかを返す関数を登録する（循環 import を避けるため、通話の側から渡す） */
  setInCall(fn: () => boolean): void {
    this.inCall = fn;
  }

  /** 画面の表示が変わった（Android）。隠れたら時刻を覚え、表示に戻ったら resumeReconnect で作り直すか決める */
  private onVisibilityChanged(): void {
    if (document.visibilityState !== 'visible') {
      this.hiddenAt ??= Date.now();
      return;
    }
    const hiddenMs = this.hiddenAt === null ? 0 : Date.now() - this.hiddenAt;
    this.hiddenAt = null;
    if (resumeReconnect({ hiddenMs, started: this.chatState === 'started', down: this.chatDown, inCall: this.inCall() })) this.restartChat();
  }

  /** 接続を作り直す（Android の復帰・ネットワーク変化）。starting のあいだは何もしない */
  private restartChat(): void {
    if (!this.chat || this.chatState === 'starting') return;
    this.clearChatRetry();
    void this.startChat();
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
        this.setLink('connecting');
        break;
      case 'connected':
        this.chatGeneration = item.generation;
        this.setLink('open');
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
        if (item.reason === 'lagged') {
          // 接続は続いている（受信の取りこぼしだけ）。つながっているのでバナーは出さず、読み直して埋める
          this.setLink('open');
          this.refreshAfterGap();
        } else {
          // 切れた。つなぎ直したら hello（applyHello）で読み直す
          this.setLink('closed');
        }
        break;
      case 'failed':
        this.chatFailed(item.reason, 'チャットの接続が止まりました');
        break;
    }
  }

  /** Rust 経路の送信。結果（SendOutcome）で仮表示を進める。送信中は busy のまま待つ */
  private async submitChat(p: PendingMessage): Promise<void> {
    const chat = this.chat;
    if (!chat) return;
    p.sent = true;
    const outcome = await chat.send({
      clientId: p.client_id,
      body: p.body,
      attachmentIds: p.attachment_ids,
      replyTo: p.reply_to,
      silent: p.silent,
    });
    if (outcome.outcome === 'notSent') p.sent = false;
    this.applySendOutcome(p.client_id, outcome);
  }

  /** 送信結果を仮表示に反映する。notSent は client_id を持たないので、送った側の clientId を使う */
  private applySendOutcome(clientId: string, outcome: SendOutcome): void {
    switch (outcome.outcome) {
      case 'confirmed':
        // echo（message.created）と同じ処理。どちらが先でも結果は同じ（冪等）
        this.main.upsert(outcome.message, outcome.clientId);
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
    const t = this.main;
    const before = t.sendState(clientId);
    const s = t.settleFromError(clientId, rejected);
    if (s) {
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
      body: ev.body,
      attachmentIds: ev.attachment_ids,
      replyTo: ev.reply_to,
      silent: ev.silent,
    });
    if (outcome.outcome === 'confirmed') return; // 表示は echo で届く
    const code = outcome.outcome === 'rejected' ? outcome.code : outcome.outcome === 'notSent' ? SEND_TEXT.codeNotSent : SEND_TEXT.codeUnknown;
    const message = outcome.outcome === 'rejected' ? outcome.message : outcome.outcome === 'notSent' ? outcome.reason || SEND_TEXT.notConnected : unknownReasonText(outcome.reason);
    this.dispatch({ type: 'error', client_id: null, code, message });
  }

  // ---- イベント処理 ----

  /**
   * 添付の名前・削除は、本文の表示（サーバーが次に返すときの今の名前）と添付の一覧に出る。
   * 名前の変更では message.updated が届かないので、添付やリンクを持つ最新のページを読み直す（短い間にまとめる）。
   */
  /**
   * 本文に添付のリンクがあれば、添付の一覧（attachments/ の写し）を捨てる。投稿の確定（未投稿だった添付が投稿済みになる）は
   * files.changed を出さないので、ここで読み直させる（投稿済みの添付だけが一覧に出る）
   */
  private dropAttachmentListing(body: string): void {
    if (body.includes('attachments/')) sharedIndex.invalidate('attachments');
  }

  private scheduleAttachmentRefresh(): void {
    if (this.attachmentTimer !== null) return;
    this.attachmentTimer = setTimeout(() => {
      this.attachmentTimer = null;
      // 読み込みの途中に変わったら、終わってからもう一度読む
      if (this.main.loading) {
        this.scheduleAttachmentRefresh();
        return;
      }
      // 表示している分（古い履歴も含む）に添付があれば、その範囲を読み直す（名前の変更・削除を反映する）
      const shown = this.main.messages.some((m) => m.attachments.length > 0 || m.body.includes('attachments/'));
      if (shown && this.main.loaded) void this.main.reloadLoaded();
    }, ATTACHMENT_REFRESH_MS);
  }

  /** 取りこぼしのあとで、読み込み済みの履歴・未読を REST で読み直す（applyHello と同じ範囲） */
  private refreshAfterGap(): void {
    if (this.main.loaded || this.main.error) void this.main.load();
    void unread.load();
  }

  private applyHello(me: User, list: User[]): void {
    this.me = me;
    const map: Record<string, User> = {};
    for (const u of list) map[u.id] = u;
    map[me.id] = me;
    this.users = map;
    this.ready = true;
    this.generation++;
    // 再接続時は、読み込み済みの履歴を取り直す
    if (this.main.loaded || this.main.error) void this.main.load();
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
        this.dropAttachmentListing(m.body);
        this.main.upsert(m, ev.client_id);
        // 自分のものは数えない。見ている場所なら、MessageList がすぐに既読にする
        unread.onMessage(m);
        break;
      }
      case 'message.updated': {
        const m = ev.message;
        this.dropAttachmentListing(m.body);
        this.main.upsert(m);
        this.main.setReplyPreview(m.id, replyPreviewOf(m));
        break;
      }
      case 'message.deleted': {
        // 未読に数えていたものなら減らす（読み込んでいなければ投稿者が分からないので、他人のものとみなす）
        unread.onDeleted(ev.message_id, this.main.find(ev.message_id)?.author_id);
        this.main.remove(ev.message_id);
        this.main.setReplyPreview(ev.message_id, null);
        // 消えたメッセージを起点にした返信のツリーは、開いていれば閉じ、遷移の履歴からも外す
        ui.forgetPanel((p) => p.kind === 'replyTree' && p.messageId === ev.message_id);
        reply.drop(ev.message_id);
        break;
      }
      case 'reaction.updated': {
        this.main.setReactions(ev.message_id, ev.reactions);
        break;
      }
      case 'user.updated': {
        this.users[ev.user.id] = ev.user;
        if (this.me?.id === ev.user.id) this.me = ev.user;
        break;
      }
      case 'notify': {
        // 接続が切れていた間の再送。アプリ内では、通常の経路で届いた分と重ねて出さない
        // （背景の通知は常駐サービスが受け持ち、表示済みかどうかを message_id で確かめている）
        if (ev.replayed) break;
        const body = mentionsToText(ev.body, (id) => this.nameOf(id));
        notifications.show({ title: ev.title, body, sample: ev.sample, from: this.senderOf(ev.message_id) });
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
        // 通話の操作の失敗は、通話の状態（call.store）が利用者へ知らせる（「通話に参加していません」を出さない）
        if (CALL_ERROR_CODES.has(ev.code)) break;
        ui.toast(text, 'error');
        break;
      }
      case 'files.changed':
        // 共有フォルダの一覧（本文のファイルリンクが引く）を捨て、添付の名前・削除を表示に反映する
        sharedIndex.invalidate(ev.path);
        if (ev.path === 'attachments' || ev.path.startsWith('attachments/')) this.scheduleAttachmentRefresh();
        break;
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
