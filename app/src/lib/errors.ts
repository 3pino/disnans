// サーバーのエラーコード → 表示用の文言
const MESSAGES: Record<string, string> = {
  unauthorized: '認証できませんでした。Tailscale に接続しているか確かめてください',
  not_found: '見つかりませんでした',
  internal: 'サーバーでエラーが起きました',
  invalid_event: '不正な操作です',
  empty_message: 'メッセージが空です',
  body_too_long: 'メッセージが長すぎます（10000文字まで）',
  reply_not_found: '返信先のメッセージが見つかりません',
  reply_other_place: '同じ場所のメッセージにだけ返信できます',
  invalid_attachment: '添付ファイルが見つかりません。もう一度アップロードしてください',
  invalid_link:
    'リンク先のファイルが見つかりません。削除されたか、名前が変わった可能性があります。リンクを直してから、もう一度送ってください',
  invalid_emoji: 'この絵文字は使えません',
  invalid_display_name: '表示名は1〜32文字にしてください',
  invalid_upload: 'アップロードに失敗しました',
  missing_file: 'ファイルがありません',
  unknown_outcome: '結果を確認できませんでした。二重投稿を防ぐため自動では再送していません',
};

export function errorText(code: string, fallback: string): string {
  return MESSAGES[code] ?? fallback;
}

export const MAX_BODY = 10_000;
