// 送信結果の表示文言と判定。文言の変更は見た目の変更なので、利用者の確認を取ってから変える。
// 文言はこの1か所にまとめる。

import type { UnknownReason } from './transport/chat';

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
];

export function isRejectedSendCode(code: string): boolean {
  return REJECTED_SEND_CODES.includes(code);
}
