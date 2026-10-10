import type { PluginEntry } from './host.svelte';
import type { PluginVisibility } from '../protocol/PluginVisibility';
import { isNewer } from '../semver';

// プラグインのアップデートの判定と表示（純粋な関数だけ。配布は deliver.ts）

/** 手元（開発用フォルダ）のバージョン。読めなければ空 */
export function localVersion(e: PluginEntry): string {
  return e.dev?.manifest?.version ?? '';
}

/** 手元のパッケージが配布済みより新しいか、版は同じでも中身が違うか（アップデートできるか） */
export function hasPluginUpdate(e: PluginEntry, localHash: string | null): boolean {
  const local = localVersion(e);
  if (!e.dev || !e.server || !local) return false;
  if (isNewer(local, e.server.version)) return true;
  return local === e.server.version && localHash !== null && localHash !== e.server.hash;
}

export function visibilityLabel(visibility: PluginVisibility): string {
  return visibility === 'private' ? '自分だけ' : 'みんな';
}

/** アップデートの説明（版が同じなら、中身が変わったことを書く）。ボタンの説明に使う */
export function pluginUpdateText(e: PluginEntry): string {
  const server = e.server;
  if (!server) return '';
  const same = localVersion(e) === server.version;
  return `v${server.version} → v${localVersion(e)}${same ? '（版は同じで中身が変わりました）' : ''}（${visibilityLabel(server.visibility)}に配布）`;
}
