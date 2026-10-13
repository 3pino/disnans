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
  emit(item: ChatItem) {
    this.onItem?.(item);
  }
}

class FakeSocket {
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
let socket: () => FakeSocket;

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
  socket = () => FakeSocket.instances[0];
  socket().open();
  chat.emit({ kind: 'connected', generation: 1, me: ME, users: [ME, BOB] });
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

  it('gives the connected hello to subscribers once, and drops the JS socket hello', () => {
    const seen: string[] = [];
    client.subscribe((ev) => seen.push(ev.type));
    chat.emit({ kind: 'connected', generation: 2, me: ME, users: [ME] });
    expect(seen.filter((t) => t === 'hello')).toHaveLength(1);
    socket().receive({ type: 'hello', me: { ...ME, display_name: 'JS' }, users: [] });
    expect(client.me?.display_name).toBe('Me');
  });

  it('drops chat events that arrive on the JS socket', () => {
    const tl = client.timeline(null);
    tl.loaded = true;
    socket().receive({ type: 'message.created', client_id: null, message: msg('m1', 'from js') });
    expect(tl.messages).toHaveLength(0);
  });

  it('keeps only chat events and errors from the Rust stream', () => {
    const seen: string[] = [];
    client.subscribe((ev) => seen.push(ev.type));
    chat.emit({ kind: 'event', generation: 1, event: { type: 'prefs.updated', prefs: {} } });
    chat.emit({ kind: 'event', generation: 1, event: { type: 'call.state', members: [] } as unknown as ServerEvent });
    chat.emit({ kind: 'event', generation: 1, event: { type: 'user.updated', user: BOB } });
    expect(seen).toEqual(['user.updated']);
  });

  it('drops items from an older generation', () => {
    chat.emit({ kind: 'connected', generation: 2, me: ME, users: [ME] });
    const seen: string[] = [];
    client.subscribe((ev) => seen.push(ev.type));
    chat.emit({ kind: 'event', generation: 1, event: { type: 'user.updated', user: BOB } });
    expect(seen).toHaveLength(0);
  });

  it('shows connecting and closed from the chat connection, not from the JS socket', () => {
    chat.emit({ kind: 'gap', generation: 1, reason: 'disconnected' });
    expect(client.status).toBe('closed');
    chat.emit({ kind: 'connecting', attempt: 1 });
    expect(client.status).toBe('connecting');
    socket().onclose?.();
    expect(client.status).toBe('connecting');
  });

  it('does not mark a sent message unknown when the chat connection drops (its outcome decides)', () => {
    chat.respond = () => new Promise<SendOutcome>(() => {});
    sendText('hi');
    chat.emit({ kind: 'gap', generation: 1, reason: 'disconnected' });
    expect(pendingOf()[0]).toMatchObject({ sent: true, unknown: false, failed: false });
  });
});

describe('chat over Rust: sending', () => {
  it('sends through ChatTransport only, never through the JS socket', async () => {
    chat.respond = (d) => ({ outcome: 'confirmed', clientId: d.clientId, message: msg('m1', d.body) });
    sendText('hi');
    expect(chat.sends).toHaveLength(1);
    await flush();
    expect(socket().sentTypes()).not.toContain('message.send');
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
    chat.emit({ kind: 'event', generation: 1, event: { type: 'message.created', client_id: clientId, message: msg('m1', 'hi') } });
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
    chat.emit({ kind: 'event', generation: 1, event: { type: 'error', client_id: clientId, code: 'empty_message', message: 'x' } });
    expect(pendingOf()[0]).toMatchObject({ failed: true, unknown: false });
  });

  it('a late non-rejected error after unknown stays unknown', async () => {
    chat.respond = (d) => ({ outcome: 'unknown', clientId: d.clientId, reason: { kind: 'disconnected' } });
    sendText('hi');
    await flush();
    const clientId = pendingOf()[0].client_id;
    chat.emit({ kind: 'event', generation: 1, event: { type: 'error', client_id: clientId, code: 'internal', message: 'x' } });
    expect(pendingOf()[0]).toMatchObject({ unknown: true, failed: false });
  });

  it('a duplicate error for an already failed send keeps the same state', async () => {
    chat.respond = (d) => ({ outcome: 'rejected', clientId: d.clientId, code: 'empty_message', message: 'x' });
    client.sendMessage({ threadId: null, body: '', files: [] });
    await flush();
    const clientId = pendingOf()[0].client_id;
    chat.emit({ kind: 'event', generation: 1, event: { type: 'error', client_id: clientId, code: 'empty_message', message: 'x' } });
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
    expect(socket().sentTypes()).not.toContain('message.send');
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
});
