import { pluginHost, type PluginEntry } from './host.svelte';
import { visibilityLabel } from './update';
import { ui } from '../stores/ui.svelte';

// プラグインのアップデートの配信（設定の一覧・プラグインの設定画面の両方から使う）

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 開発中のものの中身のハッシュを、プラグインの ID ごとに計算する（計算できなければ null） */
export function localHashes(entries: PluginEntry[]): Promise<Record<string, string | null>> {
  return Promise.all(entries.map(async (e) => [e.id, e.dev ? await pluginHost.devHash(e.dev) : null] as const)).then(
    Object.fromEntries,
  );
}

/** 配布済みと同じ範囲（自分だけなら自分だけ、みんななら みんな）へ、手元のアップデートを配布する。結果はトーストで知らせる */
export async function updatePlugin(e: PluginEntry): Promise<void> {
  if (!e.dev || !e.server) return;
  const visibility = e.server.visibility;
  try {
    const info = await pluginHost.publishDev(e.dev, visibility);
    ui.toast(`「${info.name}」を v${info.version} にアップデートしました（${visibilityLabel(visibility)}に配布）`);
  } catch (err) {
    ui.toast(`アップデートできませんでした: ${message(err)}`, 'error');
  }
}
