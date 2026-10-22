// 送信結果の表示文言と判定。文言の変更は見た目の変更なので、利用者の確認を取ってから変える。
// 文言はこの1か所にまとめる。

import type { ChatCommandError, UnknownReason } from './transport/chat';

export const SEND_TEXT = {
  /** 投稿されなかったと分かっている失敗（再送できる） */
  failed: '送信できませんでした',
  retry: '再送',
  discard: '取り消す',
  /** 投稿されたか分からない（再送しない） */
  unknown: '送信できたか確認できません。二重投稿を防ぐため、自動では再送しません',
  dismissUnknown: '確認したので消す',
  /** 結果不明のときの error の前置き */
  unknownToast: '送信結果を確認できません',
  /** 結果不明の理由（toast の後ろに付く。Rust 経路の理由） */
  reasonDisconnected: '接続が切れました',
  reasonTimeout: 'サーバーからの応答がありませんでした',
  reasonWriteFailed: '送信の書き込みに失敗しました',
  /** Rust 側の呼び出しが応答を受け取れなかった（書込んだかどうか分からない） */
  reasonBridge: '送信の結果を受け取れませんでした',
  /** 書込前に送れなかった（Rust 経路。未接続など。再送できる） */
  notConnected: 'サーバーに接続していないため送れませんでした',
  /** plugin などの生の送信が失敗したときの error の code */
  codeUnknown: 'send_unknown',
  codeNotSent: 'send_not_sent',
} as const;

/** 結果不明の理由を、toast に出す短い文にする */
export function unknownReasonText(reason: UnknownReason): string {
  switch (reason.kind) {
    case 'disconnected': return SEND_TEXT.reasonDisconnected;
    case 'timeout': return SEND_TEXT.reasonTimeout;
    case 'writeFailed': return SEND_TEXT.reasonWriteFailed;
    case 'serverError': return reason.message;
  }
}

/**
 * サーバーが、同じ client_id の送信を「投稿されていない」と保証して返すコード。
 * crates/client-core/src/ws.rs の REJECTED_CODES と同じ一覧（変えるときは両方）。
 * ほかのコードは、サーバーが投稿後に返すことがありうるので「結果不明」として扱う。
 */
export const REJECTED_SEND_CODES: readonly string[] = [
  'empty_message',
  'body_too_long',
  'nested_thread',
  'thread_not_found',
  'reply_not_found',
  'reply_other_place',
  'invalid_attachment',
  'invalid_link',
];

export function isRejectedSendCode(code: string): boolean {
  return REJECTED_SEND_CODES.includes(code);
}

/** 編集・削除・リアクション・スレッド作成が失敗したときの toast（provisional。文言の変更は利用者確認後） */
export const EMIT_TEXT = {
  notConnected: '接続中ではないため送れませんでした。接続が戻ってから、もう一度操作してください',
  writeFailed: '送信できたか確認できません。自動では再送しません。必要なら操作をやり直してください',
  notAllowed: 'この操作はここからは送れません',
  /** 音声の書込み枠が一杯（取りこぼし。通話では表示しない） */
  busy: '混み合っているため送れませんでした',
  invalid: '操作の内容が正しく送れませんでした',
} as const;

/** 診断用: chat_emit の失敗の種別と code（console に出す。利用者には出さない） */
export function describeEmitError(e: unknown): string {
  if (e && typeof e === 'object') {
    const b = e as Partial<ChatCommandError>;
    return `kind=${b.code ?? 'unknown'} message=${String(b.message ?? '')}`;
  }
  return `kind=unknown message=${String(e)}`;
}

/** chat_emit の失敗を toast の文にする（未知の形・未知の code は書込んだかどうか分からない扱い） */
export function emitFailureText(e: unknown): string {
  const code = e && typeof e === 'object' ? (e as Partial<ChatCommandError>).code : undefined;
  switch (code) {
    case 'not_connected':
      return EMIT_TEXT.notConnected;
    case 'send_not_allowed':
      return EMIT_TEXT.notAllowed;
    case 'invalid_request':
      return EMIT_TEXT.invalid;
    case 'busy':
      return EMIT_TEXT.busy;
    default:
      return EMIT_TEXT.writeFailed;
  }
}
