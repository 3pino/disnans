import { describe, expect, it, vi } from 'vitest';
import { commandError, createTauriChatTransport, type ChannelLike } from './tauriChat';
import type { ChatItem, MessageDraft } from './chat';
import { selectChatMode } from './select';
import { HttpError } from './http';

const ctx = { server: () => 'http://127.0.0.1:8080', devUser: 'alice' };

const draft: MessageDraft = {
  clientId: 'c-1', threadId: null, body: 'hi', attachmentIds: [], startThread: false, replyTo: null, silent: false,
};

function fakeChannel() {
  const ch: ChannelLike<ChatItem> & { id: string } = { id: 'ch', onmessage: () => {} };
  return { ch, make: async () => ch };
}

describe('chat over Tauri', () => {
  it('chat_start passes server, devUser and the channel, and wires items to onItem', async () => {
    const invoke = vi.fn().mockResolvedValue(null);
    const { ch, make } = fakeChannel();
    const t = createTauriChatTransport(invoke, ctx, make);
    const seen: ChatItem[] = [];
    await t.start((item) => seen.push(item));
    expect(invoke).toHaveBeenCalledWith('chat_start', { args: { server: 'http://127.0.0.1:8080', devUser: 'alice', onItem: ch } });
    ch.onmessage({ kind: 'connecting', attempt: 1 });
    expect(seen).toEqual([{ kind: 'connecting', attempt: 1 }]);
  });

  it('a failed chat_start rejects as HttpError with the bridge code', async () => {
    const invoke = vi.fn().mockRejectedValue({ status: 403, code: 'forbidden', message: 'no' });
    const { make } = fakeChannel();
    const t = createTauriChatTransport(invoke, ctx, make);
    const err = await t.start(() => {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('chat_send returns the outcome unchanged', async () => {
    const outcome = { outcome: 'unknown', clientId: 'c-1', reason: { kind: 'timeout' } };
    const invoke = vi.fn().mockResolvedValue(outcome);
    const t = createTauriChatTransport(invoke, ctx, fakeChannel().make);
    await expect(t.send(draft)).resolves.toEqual(outcome);
    expect(invoke).toHaveBeenCalledWith('chat_send', { draft });
  });

  it('a Rust refusal before the write (ReadFailure shape) is notSent, and is never resent', async () => {
    const invoke = vi.fn().mockRejectedValue({ code: 'invalid_request', message: 'bad args' });
    const t = createTauriChatTransport(invoke, ctx, fakeChannel().make);
    await expect(t.send(draft)).resolves.toEqual({ outcome: 'notSent', reason: 'bad args' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('a reject that is not a bridge error (IPC failure, missing command) is unknown, not notSent', async () => {
    const cases: unknown[] = ['command chat_send not found', new Error('ipc broke'), null, { message: 'no code' }];
    for (const e of cases) {
      const invoke = vi.fn().mockRejectedValue(e);
      const t = createTauriChatTransport(invoke, ctx, fakeChannel().make);
      const out = await t.send(draft);
      expect(out).toMatchObject({ outcome: 'unknown', clientId: 'c-1', reason: { kind: 'serverError', code: 'bridge_error' } });
    }
  });

  it('items from a previous start are dropped after a new start (late IPC delivery)', async () => {
    const invoke = vi.fn().mockResolvedValue(null);
    const channels: { ch: ChannelLike<ChatItem> }[] = [];
    const make = async () => {
      const ch: ChannelLike<ChatItem> = { onmessage: () => {} };
      channels.push({ ch });
      return ch;
    };
    const t = createTauriChatTransport(invoke, ctx, make);
    const first: ChatItem[] = [];
    const second: ChatItem[] = [];
    await t.start((i) => first.push(i));
    await t.stop();
    await t.start((i) => second.push(i));
    channels[0].ch.onmessage({ kind: 'gap', generation: 5, reason: 'old' });
    channels[1].ch.onmessage({ kind: 'connected', generation: 1, me: { id: 'me' } as never, users: [] });
    expect(first).toEqual([]);
    expect(second).toEqual([{ kind: 'connected', generation: 1, me: { id: 'me' }, users: [] }]);
  });

  it('reconnect and stop call their commands', async () => {
    const invoke = vi.fn().mockResolvedValue(null);
    const t = createTauriChatTransport(invoke, ctx, fakeChannel().make);
    await t.reconnect();
    await t.stop();
    expect(invoke.mock.calls.map((c) => c[0])).toEqual(['chat_reconnect', 'chat_stop']);
  });
});

describe('chat mode selection', () => {
  it('rust by default on the desktop; "0" turns it off; other platforms stay js', () => {
    expect(selectChatMode({ flag: null, desktop: true })).toBe('rust');
    expect(selectChatMode({ flag: '1', desktop: true })).toBe('rust');
    expect(selectChatMode({ flag: '0', desktop: true })).toBe('js');
    expect(selectChatMode({ flag: null, desktop: false })).toBe('js');
    expect(selectChatMode({ flag: '1', desktop: false })).toBe('js');
  });

  it('Android: opt-in only ("1"); null and "0" stay js (the background disconnect is not yet explained)', () => {
    expect(selectChatMode({ flag: null, desktop: false, android: true })).toBe('js');
    expect(selectChatMode({ flag: '0', desktop: false, android: true })).toBe('js');
    expect(selectChatMode({ flag: '1', desktop: false, android: true })).toBe('rust');
    expect(selectChatMode({ flag: 'yes', desktop: false, android: true })).toBe('js');
  });

  it('the full matrix: desktop default on, Android opt-in, browser and macOS always js', () => {
    const rows: [string | null, boolean, boolean, 'rust' | 'js'][] = [
      // flag, desktop, android, expected
      [null, true, false, 'rust'],
      ['1', true, false, 'rust'],
      ['0', true, false, 'js'],
      [null, false, true, 'js'],
      ['1', false, true, 'rust'],
      ['0', false, true, 'js'],
      ['1', false, false, 'js'],
      [null, false, false, 'js'],
    ];
    for (const [flag, desktop, android, want] of rows) {
      expect(selectChatMode({ flag, desktop, android })).toBe(want);
    }
  });
});

describe('chat_emit (Tauri)', () => {
  const event = { type: 'message.delete' as const, message_id: 'm1' };

  it('sends the wire event as {event} and resolves on success', async () => {
    const invoke = vi.fn().mockResolvedValue(null);
    const t = createTauriChatTransport(invoke, ctx, fakeChannel().make);
    await expect(t.emit(event)).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith('chat_emit', { event });
  });

  it('a Rust {code,message} rejection is passed through as ChatCommandError', async () => {
    const invoke = vi.fn().mockRejectedValue({ code: 'not_connected', message: 'x' });
    const t = createTauriChatTransport(invoke, ctx, fakeChannel().make);
    await expect(t.emit(event)).rejects.toEqual({ code: 'not_connected', message: 'x' });
  });

  it('any other failure (IPC, missing command) is write_failed, never success', () => {
    expect(commandError(new Error('command not found'))).toMatchObject({ code: 'write_failed' });
    expect(commandError('x')).toMatchObject({ code: 'write_failed' });
    expect(commandError(null)).toMatchObject({ code: 'write_failed' });
  });
});
