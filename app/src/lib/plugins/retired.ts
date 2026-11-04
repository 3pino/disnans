/**
 * 本体の機能に入った旧いプラグインの ID。読み込まず、一覧にも出さず、オンにもできない。
 * 配布の一覧（サーバー）と、開発用フォルダの両方に効く。レジストリ（サーバーの配布物）からは消さない（古い版の利用者のため）。
 * 画面共有は本体の機能（call/screen）になったので、`screenshare` は使わない。
 */
export const RETIRED_PLUGIN_IDS: readonly string[] = ['screenshare'];

export function isRetiredPlugin(id: string): boolean {
  return RETIRED_PLUGIN_IDS.includes(id);
}
