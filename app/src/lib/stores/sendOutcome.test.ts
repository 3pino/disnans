import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isRejectedSendCode, REJECTED_SEND_CODES } from '../sendOutcome';
import { Timeline, type PendingMessage } from './timeline.svelte';
import type { ClientEvent } from '../protocol/ClientEvent';
import type { ServerEvent } from '../protocol/ServerEvent';
import type { User } from '../protocol/User';

function pendingOf(clientId: string): PendingMessage {
  return {
    id: clientId,
    client_id: clientId,
    author_id: 'me',
    thread_id: null,
    reply_to: null,
    reply_preview: null,
    body: 'hello',
    attachments: [],
    reactions: [],
    created_at: 0,
    edited_at: null,
    thread: null,
    card: null,
    bot: null,
    sent: false,
    failed: false,
    unknown: false,
    attachment_ids: [],
    start_thread: false,
    silent: false,
    files: [],
    busy: false,
  } as unknown as PendingMessage;
}

describe('send outcome classification', () => {
  it('treats only the server-guaranteed codes as rejected', () => {
    for (const code of REJECTED_SEND_CODES) expect(isRejectedSendCode(code)).toBe(true);
    expect(isRejectedSendCode('internal')).toBe(false);
    expect(isRejectedSendCode('unauthorized')).toBe(false);
    expect(isRejectedSendCode('')).toBe(false);
  });
});

describe('timeline pending states', () => {
  it('marks sent-but-unconfirmed messages unknown, not failed', () => {
    const tl = new Timeline(null);
    const sent = pendingOf('c1');
    sent.sent = true;
    const queued = pendingOf('c2');
    tl.addPending(sent);
    tl.addPending(queued);
    tl.markSentUnknown();
    expect(sent).toMatchObject({ unknown: true, failed: false });
    expect(queued).toMatchObject({ unknown: false, failed: false });
  });

  it('does not change a message that is already rejected', () => {
    const tl = new Timeline(null);
    const p = pendingOf('c1');
    p.sent = true;
    tl.addPending(p);
    expect(tl.settleFromError('c1', true)).toBe('failed');
    tl.markSentUnknown();
    expect(p).toMatchObject({ failed: true, unknown: false });
  });

  it('settles an error by code: rejected codes give failed, others give unknown', () => {
    const tl = new Timeline(null);
    const a = pendingOf('a');
    const b = pendingOf('b');
    tl.addPending(a);
    tl.addPending(b);
    expect(tl.settleFromError('a', isRejectedSendCode('empty_message'))).toBe('failed');
    expect(tl.settleFromError('b', isRejectedSendCode('internal'))).toBe('unknown');
    expect(a).toMatchObject({ failed: true, unknown: false });
    expect(b).toMatchObject({ failed: false, unknown: true });
    expect(tl.settleFromError('missing', true)).toBeNull();
  });

  it('upgrades unknown to failed on a later rejected error, but never the reverse', () => {
    const tl = new Timeline(null);
    const p = pendingOf('c1');
    p.sent = true;
    tl.addPending(p);
    tl.markSentUnknown();
    expect(tl.settleFromError('c1', false)).toBe('unknown');
    expect(tl.settleFromError('c1', true)).toBe('failed');
    expect(p).toMatchObject({ failed: true, unknown: false });
    expect(tl.settleFromError('c1', false)).toBe('failed');
    expect(p).toMatchObject({ failed: true, unknown: false });
  });
});

/** WebSocket を差し替えて、Client の送信・切断・受信を動かす */
class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
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
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
  receive(ev: ServerEvent) {
    this.onmessage?.({ data: JSON.stringify(ev) });
  }
}

const ME: User = { id: 'me', login_name: 'me', display_name: 'Me', avatar_url: null, created_at: 0 } as unknown as User;

describe('client message delivery (JS path)', () => {
  let client: typeof import('./client.svelte').client;
  let sockets: () => FakeSocket[];

  beforeEach(async () => {
    FakeSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('window', { addEventListener() {}, location: { search: '' } });
    vi.stubGlobal('document', { addEventListener() {} });
    vi.resetModules();
    ({ client } = await import('./client.svelte'));
    sockets = () => FakeSocket.instances;
    client.start();
    sockets()[0].open();
    client.me = ME;
    client.ready = true;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const sentMessages = (s: FakeSocket) =>
    s.sent.map((x) => JSON.parse(x) as ClientEvent).filter((e) => e.type === 'message.send');

  it('a disconnect after sending makes the message unknown and never resends it', () => {
    client.sendMessage({ threadId: null, body: 'hi', files: [] });
    const s = sockets()[0];
    expect(sentMessages(s)).toHaveLength(1);
    const pending = client.timeline(null).pending[0];
    expect(pending).toMatchObject({ sent: true, failed: false, unknown: false });

    s.drop();
    expect(pending).toMatchObject({ unknown: true, failed: false });

    const totalSent = () => sockets().reduce((n, x) => n + sentMessages(x).length, 0);
    const before = totalSent();
    client.retry(null, pending.client_id);
    expect(totalSent()).toBe(before);
    expect(client.timeline(null).pending).toHaveLength(1);
  });

  it('a rejected error allows a retry with the same client_id', () => {
    client.sendMessage({ threadId: null, body: '', files: [] });
    const s = sockets()[0];
    const clientId = client.timeline(null).pending[0].client_id;
    s.receive({ type: 'error', client_id: clientId, code: 'empty_message', message: 'x' });
    expect(client.timeline(null).pending[0]).toMatchObject({ failed: true, unknown: false });

    client.retry(null, clientId);
    const again = sentMessages(s);
    expect(again.map((m) => (m.type === 'message.send' ? m.client_id : ''))).toEqual([clientId, clientId]);
  });

  it('an unknown error (e.g. internal) does not allow a retry', () => {
    client.sendMessage({ threadId: null, body: 'x', files: [] });
    const s = sockets()[0];
    const clientId = client.timeline(null).pending[0].client_id;
    s.receive({ type: 'error', client_id: clientId, code: 'internal', message: 'x' });
    expect(client.timeline(null).pending[0]).toMatchObject({ unknown: true, failed: false });
    client.retry(null, clientId);
    expect(sentMessages(s)).toHaveLength(1);
  });

  it('the echo of the message removes the pending placeholder', () => {
    client.sendMessage({ threadId: null, body: 'hi', files: [] });
    const s = sockets()[0];
    const clientId = client.timeline(null).pending[0].client_id;
    s.drop();
    expect(client.timeline(null).pending[0].unknown).toBe(true);
    // 再接続後に同じ client_id のエコーが届けば、仮表示は消える
    sockets()[1]?.open();
    const message = {
      id: 'm1', author_id: 'me', thread_id: null, reply_to: null, reply_preview: null, body: 'hi', attachments: [],
      reactions: [], created_at: 0, edited_at: null, thread: null, card: null, bot: null,
    };
    const echo: ServerEvent = { type: 'message.created', client_id: clientId, message } as unknown as ServerEvent;
    (client as unknown as { dispatch(ev: ServerEvent): void }).dispatch(echo);
    expect(client.timeline(null).pending).toHaveLength(0);
  });
});
