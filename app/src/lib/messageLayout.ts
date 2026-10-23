/**
 * メッセージの表示の仕方（設定の「メッセージの表示」）。
 * list: Slack 風（名前と時刻を上に、本文を左にそろえる）。bubble: 吹き出し（自分の発言は右、ほかの人の発言は左）
 */
export type MessageLayout = 'list' | 'bubble';

export const DEFAULT_MESSAGE_LAYOUT: MessageLayout = 'list';
