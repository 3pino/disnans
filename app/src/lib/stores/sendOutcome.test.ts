// 送信の結果の分類と仮表示の状態（Timeline）。チャットの送信の流れ（Rust 経路）は chatClient.test.ts で確かめる。
import { describe, expect, it } from 'vitest';
import { isRejectedSendCode, REJECTED_SEND_CODES } from '../sendOutcome';
import { Timeline, type PendingMessage } from './timeline.svelte';

function pendingOf(clientId: string): PendingMessage {
  return {
    id: clientId,
    client_id: clientId,
    author_id: 'me',
    reply_to: null,
    reply_preview: null,
    body: 'hello',
    attachments: [],
    reactions: [],
    created_at: 0,
    edited_at: null,
    card: null,
    bot: null,
    sent: false,
    failed: false,
    unknown: false,
    attachment_ids: [],
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
    const tl = new Timeline();
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
    const tl = new Timeline();
    const p = pendingOf('c1');
    p.sent = true;
    tl.addPending(p);
    expect(tl.settleFromError('c1', true)).toBe('failed');
    tl.markSentUnknown();
    expect(p).toMatchObject({ failed: true, unknown: false });
  });

  it('settles an error by code: rejected codes give failed, others give unknown', () => {
    const tl = new Timeline();
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
    const tl = new Timeline();
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
