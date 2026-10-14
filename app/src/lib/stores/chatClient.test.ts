import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientEvent } from '../protocol/ClientEvent';
import type { Message } from '../protocol/Message';
import type { ServerEvent } from '../protocol/ServerEvent';
import type { User } from '../protocol/User';
import type { ChatItem, ChatTransport, MessageDraft, SendOutcome } from '../transport/chat';

// Rust 経路（ChatTransport）を fake に差し替えて、client の受信・送信・二重反映・再送の規則を確かめる。

class FakeChat implements ChatTransport {
  onItem: ((item: ChatItem) => void) | null = null;
  starts = 0;
  reconnects = 0;
  startError: unknown = null;
  sends: MessageDraft[] = [];
  respond: (d: MessageDraft) => SendOutcome | Promise<SendOutcome> = () => ({ outcome: 'notSent', reason: 'not connected' });
  async start(onItem: (item: ChatItem) => void): Promise<void> {
    this.starts++;
    if (this.startError) throw this.startError;
    this.onItem = onItem;
  }
  async send(d: MessageDraft): Promise<SendOutcome> {
    this.sends.push(d);
    return await this.respond(d);
  }
  async reconnect(): Promise<void> {
    this.reconnects++;
  }
  async stop(): Promise<void> {}
  push(item: ChatItem) {
    this.onItem?.(item);
  }
  /** chat_emit（送信のみ。成功は null、失敗は emitError を投げる。emitHold があれば、それが解決するまで待つ） */
  emits: unknown[] = [];
  emitError: unknown = null;
  emitHold: Promise<void> | null = null;
  async emit(event: unknown): Promise<void> {
    this.emits.push(event);
    if (this.emitHold) await this.emitHold;
    if (this.emitError) throw this.emitError;
  }
}

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(ev: ServerEvent) {
    this.onmessage?.({ data: JSON.stringify(ev) });
  }
  sentTypes(): string[] {
    return this.sent.map((x) => (JSON.parse(x) as ClientEvent).type);
  }
}

const ME: User = { id: 'me', login_name: 'me', display_name: 'Me', avatar_url: null, created_at: 0 } as unknown as User;
const BOB: User = { id: 'bob', login_name: 'bob', display_name: 'Bob', avatar_url: null, created_at: 0 } as unknown as User;

function msg(id: string, body: string, author = 'me'): Message {
  return {
    id, author_id: author, thread_id: null, reply_to: null, reply_preview: null, body, attachments: [],
    reactions: [], created_at: 0, edited_at: null, thread: null, card: null, bot: null,
  } as unknown as Message;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let client: typeof import('./client.svelte').client;
let ui: typeof import('./ui.svelte').ui;
const toastTexts = () => ui.toasts.map((t) => t.text);
let chat: FakeChat;

beforeEach(async () => {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('window', { addEventListener() {}, location: { search: '' } });
  vi.stubGlobal('document', { addEventListener() {} });
  vi.stubGlobal('fetch', async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.resetModules();
  ({ client } = await import('./client.svelte'));
  ({ ui } = await import('./ui.svelte'));
  chat = new FakeChat();
  client.start(chat);
  chat.push({ kind: 'connected', generation: 1, me: ME, users: [ME, BOB] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const sendText = (body: string) => client.sendMessage({ threadId: null, body, files: [] });
const pendingOf = () => client.timeline(null).pending;

describe('chat over Rust: receiving', () => {
  it('starts the chat once and reflects connection state', () => {
    expect(chat.starts).toBe(1);
    expect(client.ready).toBe(true);
    expect(client.me?.id).toBe('me');
    expect(client.status).toBe('open');
  });

  it('gives the connected hello to subscribers once; no JS socket is created in the Rust mode', () => {
    const seen: string[] = [];
    client.subscribe((ev) => seen.push(ev.type));
    chat.push({ kind: 'connected', generation: 2, me: ME, users: [ME] });
    expect(seen.filter((t) => t === 'hello')).toHaveLength(1);
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('keeps only chat, session, plugin, prefs and call events from the Rust stream (drops pong)', () => {
    const seen: string[] = [];
    client.subscribe((ev) => seen.push(ev.type));
    chat.push({ kind: 'event', generation: 1, event: { type: 'prefs.updated', prefs: {} } });
    chat.push({ kind: 'event', generation: 1, event: { type: 'pong' } as unknown as ServerEvent });
    chat.push({ kind: 'event', generation: 1, event: { type: 'user.updated', user: BOB } });
    expect(seen).toEqual(['prefs.updated', 'user.updated']);
  });

  it('drops items from an older generation', () => {
    chat.push({ kind: 'connected', generation: 2, me: ME, users: [ME] });
    const seen: string[] = [];
    client.subscribe((ev) => seen.push(ev.type));
    chat.push({ kind: 'event', generation: 1, event: { type: 'user.updated', user: BOB } });
    expect(seen).toHaveLength(0);
  });

  it('shows connecting and closed from the chat connection', () => {
    chat.push({ kind: 'gap', generation: 1, reason: 'disconnected' });
    expect(client.status).toBe('closed');
    chat.push({ kind: 'connecting', attempt: 1 });
    expect(client.status).toBe('connecting');
  });

  it('does not mark a sent message unknown when the chat connection drops (its outcome decides)', () => {
    chat.respond = () => new Promise<SendOutcome>(() => {});
    sendText('hi');
    chat.push({ kind: 'gap', generation: 1, reason: 'disconnected' });
    expect(pendingOf()[0]).toMatchObject({ sent: true, unknown: false, failed: false });
  });
});

describe('chat over Rust: sending', () => {
  it('sends through ChatTransport only, never through the JS socket', async () => {
    chat.respond = (d) => ({ outcome: 'confirmed', clientId: d.clientId, message: msg('m1', d.body) });
    sendText('hi');
    expect(chat.sends).toHaveLength(1);
    await flush();
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('confirmed removes the placeholder and shows the message', async () => {
    const tl = client.timeline(null);
    tl.loaded = true;
    chat.respond = (d) => ({ outcome: 'confirmed', clientId: d.clientId, message: msg('m1', d.body) });
    sendText('hi');
    await flush();
    expect(pendingOf()).toHaveLength(0);
    expect(tl.messages.map((m) => m.id)).toEqual(['m1']);
  });

  it('echo first, then confirmed: one message, no placeholder (order independent)', async () => {
    const tl = client.timeline(null);
    tl.loaded = true;
    let resolve!: (o: SendOutcome) => void;
    chat.respond = () => new Promise<SendOutcome>((r) => (resolve = r));
    sendText('hi');
    const clientId = chat.sends[0].clientId;
    chat.push({ kind: 'event', generation: 1, event: { type: 'message.created', client_id: clientId, message: msg('m1', 'hi') } });
    expect(pendingOf()).toHaveLength(0);
    resolve({ outcome: 'confirmed', clientId, message: msg('m1', 'hi') });
    await flush();
    expect(tl.messages.filter((m) => m.id === 'm1')).toHaveLength(1);
    expect(pendingOf()).toHaveLength(0);
  });

  it('rejected allows a retry with the same client_id', async () => {
    chat.respond = (d) => ({ outcome: 'rejected', clientId: d.clientId, code: 'empty_message', message: 'x' });
    client.sendMessage({ threadId: null, body: '', files: [] });
    await flush();
    const clientId = pendingOf()[0].client_id;
    expect(pendingOf()[0]).toMatchObject({ failed: true, unknown: false });
    chat.respond = (d) => ({ outcome: 'confirmed', clientId: d.clientId, message: msg('m2', d.body) });
    client.retry(null, clientId);
    await flush();
    expect(chat.sends.map((d) => d.clientId)).toEqual([clientId, clientId]);
  });

  it('notSent shows the reason from Rust, and the default text only when there is none', async () => {
    chat.respond = () => ({ outcome: 'notSent', reason: '本文が空です' });
    sendText('hi');
    await flush();
    expect(toastTexts().some((t) => t.includes('本文が空です'))).toBe(true);
    expect(toastTexts().some((t) => t.includes('サーバーに接続していない'))).toBe(false);

    chat.respond = () => ({ outcome: 'notSent', reason: '' });
    sendText('again');
    await flush();
    expect(toastTexts().some((t) => t.includes('サーバーに接続していないため送れませんでした'))).toBe(true);
  });

  it('a send that the bridge could not report is unknown and not retried', async () => {
    chat.respond = (d) => ({ outcome: 'unknown', clientId: d.clientId, reason: { kind: 'serverError', code: 'bridge_error', message: '送信の結果を受け取れませんでした' } });
    sendText('hi');
    await flush();
    const clientId = pendingOf()[0].client_id;
    expect(pendingOf()[0]).toMatchObject({ unknown: true, failed: false });
    client.retry(null, clientId);
    expect(chat.sends).toHaveLength(1);
  });

  it('notSent is a failed placeholder that can be retried', async () => {
    sendText('hi');
    await flush();
    const clientId = pendingOf()[0].client_id;
    expect(pendingOf()[0]).toMatchObject({ failed: true, unknown: false, sent: false });
    chat.respond = (d) => ({ outcome: 'confirmed', clientId: d.clientId, message: msg('m3', d.body) });
    client.retry(null, clientId);
    await flush();
    expect(chat.sends).toHaveLength(2);
    expect(pendingOf()).toHaveLength(0);
  });

  it('unknown is never retried', async () => {
    chat.respond = (d) => ({ outcome: 'unknown', clientId: d.clientId, reason: { kind: 'timeout' } });
    sendText('hi');
    await flush();
    const clientId = pendingOf()[0].client_id;
    expect(pendingOf()[0]).toMatchObject({ unknown: true, failed: false });
    client.retry(null, clientId);
    await flush();
    expect(chat.sends).toHaveLength(1);
  });

  it('a late REJECTED error after unknown moves it to failed (retry allowed)', async () => {
    chat.respond = (d) => ({ outcome: 'unknown', clientId: d.clientId, reason: { kind: 'timeout' } });
    sendText('hi');
    await flush();
    const clientId = pendingOf()[0].client_id;
    chat.push({ kind: 'event', generation: 1, event: { type: 'error', client_id: clientId, code: 'empty_message', message: 'x' } });
    expect(pendingOf()[0]).toMatchObject({ failed: true, unknown: false });
  });

  it('a late non-rejected error after unknown stays unknown', async () => {
    chat.respond = (d) => ({ outcome: 'unknown', clientId: d.clientId, reason: { kind: 'disconnected' } });
    sendText('hi');
    await flush();
    const clientId = pendingOf()[0].client_id;
    chat.push({ kind: 'event', generation: 1, event: { type: 'error', client_id: clientId, code: 'internal', message: 'x' } });
    expect(pendingOf()[0]).toMatchObject({ unknown: true, failed: false });
  });

  it('a duplicate error for an already failed send keeps the same state', async () => {
    chat.respond = (d) => ({ outcome: 'rejected', clientId: d.clientId, code: 'empty_message', message: 'x' });
    client.sendMessage({ threadId: null, body: '', files: [] });
    await flush();
    const clientId = pendingOf()[0].client_id;
    chat.push({ kind: 'event', generation: 1, event: { type: 'error', client_id: clientId, code: 'empty_message', message: 'x' } });
    expect(pendingOf()[0]).toMatchObject({ failed: true, unknown: false });
  });
});

describe('chat over Rust: plugin raw message.send', () => {
  it('goes to ChatTransport, creates no placeholder, and reports a failure to subscribers', async () => {
    const errors: ServerEvent[] = [];
    client.subscribe((ev) => {
      if (ev.type === 'error') errors.push(ev);
    });
    chat.respond = () => ({ outcome: 'notSent', reason: 'not connected' });
    const raw: ClientEvent = {
      type: 'message.send', client_id: 'p1', thread_id: null, body: 'x', attachment_ids: [],
      start_thread: false, reply_to: null, silent: false,
    };
    client.send(raw);
    expect(chat.sends.map((d) => d.clientId)).toEqual(['p1']);
    expect(FakeSocket.instances).toHaveLength(0);
    expect(pendingOf()).toHaveLength(0);
    await flush();
    expect(errors.map((e) => (e.type === 'error' ? e.code : ''))).toEqual(['send_not_sent']);
  });
});

describe('chat over Rust: start and reconnect', () => {
  it('a failed start is not replaced by the JS chat, and reconnect starts it again', async () => {
    FakeSocket.instances = [];
    vi.resetModules();
    ({ client } = await import('./client.svelte'));
    chat = new FakeChat();
    chat.startError = new Error('boom');
    client.start(chat);
    await flush();
    expect(client.status).toBe('closed');
    expect(client.ready).toBe(false);
    chat.startError = null;
    client.reconnect();
    await flush();
    expect(chat.starts).toBe(2);
    expect(chat.reconnects).toBe(0);
  });

  it('reconnect after a started chat calls the transport reconnect, not start', () => {
    client.reconnect();
    expect(chat.reconnects).toBe(1);
    expect(chat.starts).toBe(1);
  });

  describe('chat over Rust: edit / delete / reaction / thread create (chat_emit)', () => {
    beforeEach(() => {
      client.timeline(null).loaded = true;
      client.timeline(null).messages = [msg('m1', 'old')];
    });

    it('goes through chat_emit with the wire JSON, never through the JS socket', async () => {
      const m = client.timeline(null).messages[0];
      client.editMessage(m, 'new');
      client.deleteMessage(m);
      client.toggleReaction(m, '👍');
      client.openThreadFrom(m);
      await flush();
      expect(chat.emits).toEqual([
        { type: 'message.edit', message_id: 'm1', body: 'new' },
        { type: 'message.delete', message_id: 'm1' },
        { type: 'reaction.add', message_id: 'm1', emoji: '👍' },
        { type: 'thread.create', root_message_id: 'm1' },
      ]);
      expect(FakeSocket.instances).toHaveLength(0);
    });

    it('a failed chat_emit shows a toast and is not resent', async () => {
      chat.emitError = { code: 'not_connected', message: 'x' };
      const m = client.timeline(null).messages[0];
      client.deleteMessage(m);
      await flush();
      expect(chat.emits).toHaveLength(1);
      expect(ui.toasts.at(-1)?.text).toContain('接続中ではないため送れませんでした');
      expect(ui.toasts.at(-1)?.kind).toBe('error');
    });

    it('write_failed is shown as unknown (never retried automatically)', async () => {
      chat.emitError = { code: 'write_failed', message: 'x' };
      client.toggleReaction(client.timeline(null).messages[0], '👍');
      await flush();
      expect(chat.emits).toHaveLength(1);
      expect(ui.toasts.at(-1)?.text).toContain('送信できたか確認できません');
    });

    it('an unknown error shape is treated as write_failed (not success, not retried)', async () => {
      chat.emitError = new Error('ipc broke');
      client.deleteMessage(client.timeline(null).messages[0]);
      await flush();
      expect(chat.emits).toHaveLength(1);
      expect(ui.toasts.at(-1)?.text).toContain('送信できたか確認できません');
    });
  });

  describe('chat over Rust: routing, duplicate prevention, buffering, retry (S1/S2/S3)', () => {
    it('session, plugin and call events all go through chat_emit; ping never does', async () => {
      client.send({ type: 'session.emit', session_id: 's1', name: 'n', payload: null });
      client.send({ type: 'plugin.emit', plugin: 'p', name: 'n', payload: null });
      client.send({ type: 'call.join', peer: 'bob', status: null } as unknown as ClientEvent);
      client.send({ type: 'call.emit', name: 'audio', payload: null } as unknown as ClientEvent);
      client.send({ type: 'call.update', status: null } as unknown as ClientEvent);
      client.send({ type: 'call.kick', peer: 'bob' } as unknown as ClientEvent);
      client.send({ type: 'call.leave' } as unknown as ClientEvent);
      await flush();
      // 音声は並行、制御は直列（順序は次のテストで確かめる）。ここは種類だけ
      expect(chat.emits.map((e) => (e as { type: string }).type).sort()).toEqual([
        'call.emit',
        'call.join',
        'call.kick',
        'call.leave',
        'call.update',
        'plugin.emit',
        'session.emit',
      ]);
      expect(FakeSocket.instances).toHaveLength(0);
    });

    it('a Rust-owned event is handled once (from Rust); the JS socket is never used', () => {
      const seen: string[] = [];
      client.subscribe((ev) => seen.push(ev.type));
      chat.push({ kind: 'event', generation: 1, event: { type: 'session.updated', session: {} } as unknown as ServerEvent });
      chat.push({ kind: 'event', generation: 1, event: { type: 'plugin.event', plugin: 'p', from: 'bob', name: 'n', payload: null } as unknown as ServerEvent });
      expect(seen).toEqual(['session.updated', 'plugin.event']);
      expect(FakeSocket.instances).toHaveLength(0);
    });

    it('call events (state, event, kicked) are received from the chat stream', () => {
      const seen: string[] = [];
      client.subscribe((ev) => seen.push(ev.type));
      chat.push({ kind: 'event', generation: 1, event: { type: 'call.event', peer: 'p', from: 'bob', name: 'audio', payload: null } as unknown as ServerEvent });
      chat.push({ kind: 'event', generation: 1, event: { type: 'call.state', members: [] } as unknown as ServerEvent });
      chat.push({ kind: 'event', generation: 1, event: { type: 'call.kicked', by: 'bob' } as unknown as ServerEvent });
      expect(seen).toEqual(['call.event', 'call.state', 'call.kicked']);
    });

    it('sendBuffered is the approximation: the bytes of in-flight chat_emit, nothing else', async () => {
      expect(client.sendBuffered).toBe(0);
      let release!: () => void;
      chat.emitHold = new Promise<void>((r) => (release = r));
      client.send({ type: 'call.emit', name: 'audio', payload: { big: 'x'.repeat(50) } } as unknown as ClientEvent);
      expect(client.sendBuffered).toBeGreaterThan(50);
      release();
      await flush();
      expect(client.sendBuffered).toBe(0);
    });

    it('a call.emit failure is silent (audio may be dropped), but a call.join failure is shown', async () => {
      chat.emitError = { code: 'not_connected', message: 'x' };
      const before = ui.toasts.length;
      client.send({ type: 'call.emit', name: 'audio', payload: null } as unknown as ClientEvent);
      await flush();
      expect(ui.toasts.length).toBe(before);
      client.send({ type: 'call.join', peer: 'bob', status: null } as unknown as ClientEvent);
      await flush();
      expect(ui.toasts.length).toBe(before + 1);
    });

    it('call.join is re-sent on reconnect through the hello from chat (the call store does it)', () => {
      const seen: string[] = [];
      client.subscribe((ev) => seen.push(ev.type));
      chat.push({ kind: 'connected', generation: 3, me: ME, users: [ME] });
      expect(seen).toContain('hello');
    });

    it('a terminal failure shows one toast, then retries every 30 seconds until it connects', async () => {
      vi.useFakeTimers();
      try {
        chat.push({ kind: 'failed', reason: '401 unauthorized', httpStatus: 401 });
        expect(client.chatDown).toBe(true);
        expect(ui.toasts.filter((t) => t.text.includes('チャットの接続が止まりました'))).toHaveLength(1);

        chat.startError = new Error('401 again');
        await vi.advanceTimersByTimeAsync(30_000);
        expect(chat.starts).toBe(2);
        expect(client.chatDown).toBe(true);
        expect(ui.toasts.filter((t) => t.text.includes('チャットに接続できませんでした'))).toHaveLength(0);

        chat.startError = null;
        await vi.advanceTimersByTimeAsync(30_000);
        expect(chat.starts).toBe(3);
        chat.push({ kind: 'connecting', attempt: 1 });
        chat.push({ kind: 'connected', generation: 2, me: ME, users: [ME] });
        expect(client.chatDown).toBe(false);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(chat.starts).toBe(3);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('chat over Rust: busy, call control order, gap resync (S3 review)', () => {
    const urls = (f: ReturnType<typeof vi.fn>) => f.mock.calls.map((c) => String(c[0]));

    it('a busy call.emit (audio frame) is dropped silently', async () => {
      chat.emitError = { code: 'busy', message: 'x' };
      const before = ui.toasts.length;
      client.send({ type: 'call.emit', name: 'audio', payload: null } as unknown as ClientEvent);
      await flush();
      expect(ui.toasts.length).toBe(before);
    });

    it('call control (join/leave/update/kick) is sent one after another, in order', async () => {
      let release!: () => void;
      chat.emitHold = new Promise<void>((r) => (release = r));
      client.send({ type: 'call.join', peer: 'bob', status: null } as unknown as ClientEvent);
      client.send({ type: 'call.update', status: null } as unknown as ClientEvent);
      client.send({ type: 'call.leave' } as unknown as ClientEvent);
      await flush();
      expect(chat.emits.map((e) => (e as { type: string }).type)).toEqual(['call.join']);
      chat.emitHold = null;
      release();
      await flush();
      await flush();
      expect(chat.emits.map((e) => (e as { type: string }).type)).toEqual(['call.join', 'call.update', 'call.leave']);
    });

    it('audio is not held behind call control (it may run in parallel)', async () => {
      let release!: () => void;
      chat.emitHold = new Promise<void>((r) => (release = r));
      client.send({ type: 'call.join', peer: 'bob', status: null } as unknown as ClientEvent);
      client.send({ type: 'call.emit', name: 'audio', payload: null } as unknown as ClientEvent);
      await flush();
      expect(chat.emits.map((e) => (e as { type: string }).type).sort()).toEqual(['call.emit', 'call.join']);
      release();
      await flush();
    });

    it('lagged: the connection stays up (no closed banner) and the history is read again over REST', async () => {
      const f = vi.fn(async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }));
      vi.stubGlobal('fetch', f);
      client.timeline(null).loaded = true;
      chat.push({ kind: 'gap', generation: 1, reason: 'lagged' });
      expect(client.status).toBe('open');
      await flush();
      expect(urls(f).some((u) => u.includes('/api/messages'))).toBe(true);
    });

    it('disconnected: closed until the chat reconnects, then the history is read again', async () => {
      const f = vi.fn(async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }));
      vi.stubGlobal('fetch', f);
      client.timeline(null).loaded = true;
      chat.push({ kind: 'gap', generation: 1, reason: 'disconnected' });
      expect(client.status).toBe('closed');
      chat.push({ kind: 'connecting', attempt: 1 });
      chat.push({ kind: 'connected', generation: 2, me: ME, users: [ME] });
      await flush();
      expect(client.status).toBe('open');
      expect(urls(f).some((u) => u.includes('/api/messages'))).toBe(true);
    });
  });
});
