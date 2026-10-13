import { describe, expect, it, vi } from 'vitest';
import { createTauriChatTransport, type ChannelLike } from './tauriChat';
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

  it('a rejected chat_send becomes notSent (never a thrown error, never a resend)', async () => {
    const invoke = vi.fn().mockRejectedValue({ code: 'bridge_error', message: 'bad args' });
    const t = createTauriChatTransport(invoke, ctx, fakeChannel().make);
    await expect(t.send(draft)).resolves.toEqual({ outcome: 'notSent', reason: 'bad args' });
    expect(invoke).toHaveBeenCalledTimes(1);
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
  it('rust only with the flag "1" on the desktop', () => {
    expect(selectChatMode({ flag: '1', desktop: true })).toBe('rust');
    expect(selectChatMode({ flag: '1', desktop: false })).toBe('js');
    expect(selectChatMode({ flag: '0', desktop: true })).toBe('js');
    expect(selectChatMode({ flag: null, desktop: true })).toBe('js');
  });
});
