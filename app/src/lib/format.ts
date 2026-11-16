// 時刻・大きさ・名前の書き方。時刻と大きさ（formatTime・formatFull・formatStamp・formatSize）は、
// エクスプローラーと同じものを使う（共有の部品 @3pino/explorer-kit の format）。
import { startOfDay } from '@3pino/explorer-kit';

export { formatTime, formatFull, formatStamp, formatSize } from '@3pino/explorer-kit';

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

export function sameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

export function dayLabel(ts: number, now: number): string {
  const diff = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000);
  if (diff === 0) return '今日';
  if (diff === 1) return '昨日';
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return `${sameYear ? '' : d.getFullYear() + '年'}${d.getMonth() + 1}月${d.getDate()}日(${WEEK[d.getDay()]})`;
}

export function relative(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return 'たった今';
  if (s < 3600) return `${Math.floor(s / 60)}分前`;
  if (s < 86_400) return `${Math.floor(s / 3600)}時間前`;
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000);
  if (days === 1) return '昨日';
  if (days < 7) return `${days}日前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** ID から決まる色相（アバターの色分け用） */
export function hueOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function initials(name: string): string {
  const s = name.trim();
  if (!s) return '?';
  return [...s][0].toUpperCase();
}
