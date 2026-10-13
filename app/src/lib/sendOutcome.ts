// 送信結果の表示文言と判定。文言の変更は見た目の変更なので、利用者の確認を取ってから変える。
// 文言はこの1か所にまとめる。

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
} as const;

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
