/**
 * メッセージの表示の仕方。一覧（Slack 風: 名前と時刻を上に、本文を左にそろえる）のみ。
 * 吹き出しは撤去した（誰も使っていなかった）。保存された旧い値（'bubble' など）は見ず、一覧として扱う。
 */
export type MessageLayout = 'list';

export const DEFAULT_MESSAGE_LAYOUT: MessageLayout = 'list';
