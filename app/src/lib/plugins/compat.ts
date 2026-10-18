import type { Manifest } from './types';

/**
 * 削った・意味を変えた API の表（版 → 説明）。
 * プラグインの対象の版（manifest の apiVersion。省略時は minApiVersion）より新しい行があれば、
 * 読み込んだうえで設定のプラグイン一覧に警告を出す。新しく削る・意味を変えるときは、ここに 1 行足して版を上げる。
 * text は「v○○ で」の後ろに続く文。
 */
export const API_CHANGES: readonly { version: number; text: string }[] = [
  { version: 13, text: 'スレッドの API が削除されました' },
  { version: 14, text: 'エラーの形が変わりました（disnans.PluginError と code）' },
];

/** プラグインの対象の版（apiVersion があればそれ、なければ minApiVersion） */
export function targetApiVersion(manifest: Pick<Manifest, 'minApiVersion' | 'apiVersion'>): number {
  return manifest.apiVersion ?? manifest.minApiVersion;
}

/**
 * 対象の版より新しい変更の警告（なければ空）。例: 「このプラグインは v12 向けです。v13 でスレッドの API が削除されました」。
 * host は本体のホスト API の版（API_VERSION）。それより新しい変更は含めない（本体が知らない変更は書けない）
 */
export function apiWarnings(manifest: Pick<Manifest, 'minApiVersion' | 'apiVersion'>, host: number, changes = API_CHANGES): string[] {
  const target = targetApiVersion(manifest);
  const newer = changes.filter((c) => c.version > target && c.version <= host);
  if (newer.length === 0) return [];
  return [`このプラグインは v${target} 向けです。${newer.map((c) => `v${c.version} で${c.text}`).join('。')}`];
}
