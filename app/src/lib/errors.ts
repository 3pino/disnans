// サーバーのエラーコード → 表示用の文言
const MESSAGES: Record<string, string> = {
  unauthorized: '認証できませんでした。Tailscale に接続しているか確かめてください',
  not_found: '見つかりませんでした',
  internal: 'サーバーでエラーが起きました',
  invalid_event: '不正な操作です',
  empty_message: 'メッセージが空です',
  body_too_long: 'メッセージが長すぎます（10000文字まで）',
  nested_thread: 'スレッドの中ではスレッドを作れません',
  thread_exists: 'このメッセージには、すでにスレッドがあります',
  thread_not_found: 'スレッドが見つかりません',
  reply_not_found: '返信先のメッセージが見つかりません',
  reply_other_place: '同じ場所のメッセージにだけ返信できます',
  title_too_long: 'スレッドのタイトルが長すぎます（100文字まで）',
  invalid_tag: 'タグが不正です（1〜24文字、アイコンは英小文字・数字・ハイフン）',
  too_many_tags: 'タグは10個までです',
  invalid_attachment: '添付ファイルが見つかりません。もう一度アップロードしてください',
  invalid_emoji: 'この絵文字は使えません',
  invalid_display_name: '表示名は1〜32文字にしてください',
  invalid_upload: 'アップロードに失敗しました',
  missing_file: 'ファイルがありません',
};

export function errorText(code: string, fallback: string): string {
  return MESSAGES[code] ?? fallback;
}

export const MAX_BODY = 10_000;
