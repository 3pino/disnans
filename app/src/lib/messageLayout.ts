/**
 * メッセージの表示の仕方（設定の「メッセージの表示」）。
 * list: Slack 風（名前と時刻を上に、本文を左にそろえる）。bubble: 吹き出し（自分の発言は右、ほかの人の発言は左）
 */
export type MessageLayout = 'list' | 'bubble';

export const DEFAULT_MESSAGE_LAYOUT: MessageLayout = 'list';

/** 保存したもの（サーバーの設定の messageLayout）を読む。読めない値は既定（リスト） */
export function normalizeMessageLayout(raw: unknown): MessageLayout {
  return raw === 'bubble' ? 'bubble' : DEFAULT_MESSAGE_LAYOUT;
}
