// localStorage / sessionStorage のキーの一覧（本体のコードが使うものすべて）。
// 読み書きは lib/storage.ts（getItem / setItem）を通す。ここに無いキーを使うと、test（localKeys.test.ts）が止める。
// kind:
// - cache: 再構成できる写し（サーバーの値の写し）。消えても困らない
// - state: 利用者の状態（サーバー・端末・下書きなど）。消すと困る
// - flag: 値が 1 つだけの印（例: 写真の許可を一度尋ねたか）。開発用の隠しスイッチは持たない
// - legacy-import: 以前の保存先。読むのは一度の取り込みだけ。書かない（消さずに残す）
// - plugin: プラグインごとのデータ（キーは disnans.plugin.<id>.data）
// prefix: true は、そのキーで始まるキー（動的なキー）の一覧。完全一致の項目が先に当たる。

export type LocalKeyKind = 'cache' | 'state' | 'flag' | 'legacy-import' | 'plugin';

export type LocalKey = {
  key: string;
  prefix?: true;
  scope: 'local' | 'session';
  owner: string;
  purpose: string;
  kind: LocalKeyKind;
};

export const LOCAL_KEYS: readonly LocalKey[] = [
  // ---- 利用者の状態 ----
  { key: 'disnans.server', scope: 'local', owner: 'lib/config.ts（sharedStorage も旧の値として読む）', purpose: 'サーバーの URL（ブラウザー・Android）', kind: 'state' },
  { key: 'disnans.devUser', scope: 'session', owner: 'lib/config.ts', purpose: '開発用のユーザー（DEV のみ。タブごと）', kind: 'state' },
  { key: 'disnans.updateCheckedAt', scope: 'local', owner: 'lib/updateWatch.ts', purpose: '最後に更新を確かめた時刻', kind: 'state' },
  { key: 'disnans.updateNotifiedVersion', scope: 'local', owner: 'lib/updateWatch.ts', purpose: '更新を知らせた版', kind: 'state' },
  { key: 'disnans.deviceName', scope: 'local', owner: 'lib/stores/deviceSettings.svelte.ts', purpose: 'この端末の名前', kind: 'state' },
  { key: 'disnans.diagLog', scope: 'local', owner: 'lib/diagLog.ts', purpose: '診断ログの行（Android はネイティブが持つ）', kind: 'state' },
  { key: 'disnans.draft.', prefix: true, scope: 'local', owner: 'lib/drafts.ts・lib/sharedStorage.ts', purpose: '打ちかけの文章（下書き）', kind: 'state' },
  { key: 'disnans.recentImages.asked', scope: 'local', owner: 'lib/recentImagesNative.ts', purpose: '写真の許可を一度尋ねたか', kind: 'flag' },

  // ---- 再構成できる写し ----
  { key: 'disnans.prefs', scope: 'local', owner: 'lib/stores/prefs.svelte.ts', purpose: 'ユーザー共通の設定の写し（起動を速くする）', kind: 'cache' },
  { key: 'disnans.devicePrefs', scope: 'local', owner: 'lib/stores/deviceSettings.svelte.ts', purpose: 'この端末の設定の写し（起動を速くする）', kind: 'cache' },
  { key: 'disnans.customTheme.cache', scope: 'local', owner: 'lib/plugins/themes.svelte.ts', purpose: '独自テーマの CSS の写し（上限あり）', kind: 'cache' },


  // ---- プラグインのデータ ----
  { key: 'disnans.plugin.', prefix: true, scope: 'local', owner: 'lib/plugins/runtime.ts', purpose: 'プラグインごとのデータ（disnans.plugin.<id>.data）', kind: 'plugin' },

  // ---- 以前の保存先（読むだけ。取り込みのあと、消さずに残す） ----
  { key: 'disnans.theme', scope: 'local', owner: 'lib/settingsModel.ts（LEGACY）', purpose: '以前のテーマ', kind: 'legacy-import' },
  { key: 'disnans.customTheme', scope: 'local', owner: 'lib/settingsModel.ts（LEGACY）', purpose: '以前の独自テーマ', kind: 'legacy-import' },
  { key: 'disnans.navBarItems', scope: 'local', owner: 'lib/settingsModel.ts（LEGACY）', purpose: '以前のナビバーの項目', kind: 'legacy-import' },
  { key: 'disnans.navBarLabels', scope: 'local', owner: 'lib/settingsModel.ts（LEGACY）', purpose: '以前のナビバーの表示', kind: 'legacy-import' },
  { key: 'disnans.call.settings', scope: 'local', owner: 'lib/settingsModel.ts（LEGACY）', purpose: '以前の通話の設定', kind: 'legacy-import' },
  { key: 'disnans.plugin.voice.data', scope: 'local', owner: 'lib/settingsModel.ts（LEGACY）', purpose: '以前の通話プラグインの保存先', kind: 'legacy-import' },
  { key: 'disnans.plugin.screenshare.data', scope: 'local', owner: 'lib/settingsModel.ts（LEGACY）', purpose: '以前の画面共有プラグインの保存先', kind: 'legacy-import' },
  { key: 'disnans.hideNavigationBar', scope: 'local', owner: 'lib/settingsModel.ts（LEGACY）', purpose: '以前のナビゲーションバーの表示', kind: 'legacy-import' },
  { key: 'disnans.orientation', scope: 'local', owner: 'lib/settingsModel.ts（LEGACY）', purpose: '以前の画面の向き', kind: 'legacy-import' },
  { key: 'disnans.deviceKind', scope: 'local', owner: 'lib/settingsModel.ts（LEGACY）', purpose: '以前の端末の種類', kind: 'legacy-import' },
  { key: 'disnans.plugins.disabled', scope: 'local', owner: 'lib/settingsModel.ts（LEGACY）', purpose: '以前の無効なプラグイン', kind: 'legacy-import' },
  { key: 'disnans.plugins.devDir', scope: 'local', owner: 'lib/settingsModel.ts（LEGACY）', purpose: '以前の開発用プラグインの場所', kind: 'legacy-import' },
  { key: 'disnans.explorer.dirs', scope: 'local', owner: 'lib/explorerDirs.ts（LEGACY_EXPLORER_KEYS）', purpose: '以前のフォルダごとの表示（取り込みのあと残す）', kind: 'legacy-import' },
  { key: 'disnans.explorer.view', scope: 'local', owner: 'lib/explorerDirs.ts（LEGACY_EXPLORER_KEYS）', purpose: '以前の表示方法（ルート）', kind: 'legacy-import' },
  { key: 'disnans.explorer.sort', scope: 'local', owner: 'lib/explorerDirs.ts（LEGACY_EXPLORER_KEYS）', purpose: '以前の並び順（ルート）', kind: 'legacy-import' },
];

/** キーに当たる登録（完全一致が先。無ければ、prefix で始まるもの）。登録が無ければ undefined */
export function registeredKey(key: string): LocalKey | undefined {
  return LOCAL_KEYS.find((k) => !k.prefix && k.key === key) ?? LOCAL_KEYS.find((k) => k.prefix && key.startsWith(k.key));
}
