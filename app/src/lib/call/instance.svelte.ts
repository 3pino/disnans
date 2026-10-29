import { client } from '../stores/client.svelte';
import { ui } from '../stores/ui.svelte';
import { deviceKind } from '../deviceKind.svelte';
import { holdBackground, onBackgroundServiceFailed } from '../plugins/background';
import { audio } from '../plugins/audio';
import { toPluginUser } from '../plugins/sessions';
import { createCallApi } from './api';
import { callSettings } from './settings.svelte';
import { CallStore } from './store.svelte';
import { viewTexts } from '../viewTexts';
import { isAndroid, isTauri } from '../platform';
import { createTauriNativePort } from './nativePort';
import { devUser, getServerUrl, onServerChange } from '../config';

/** Android（Tauri）の通話は、参加・マイク・音・再接続をネイティブが持つ。それ以外（Windows・Linux）は従来の WebView の通話 */
const nativePort = isTauri() && isAndroid() ? createTauriNativePort() : undefined;

/** アプリの通話（シングルトン）。画面・コマンド・プラグイン API が使う */
export const call = new CallStore({
  native: nativePort,
  serverUrl: () => getServerUrl(),
  devUser: () => devUser,
  send: (ev) => void client.send(ev),
  meId: () => client.me?.id ?? '',
  nameOf: (id) => client.nameOf(id),
  toast: (text, kind) => ui.toast(text, kind),
  confirm: (o) => ui.confirm(o),
  hold: (opts) => holdBackground(opts),
  onServiceFailed: (cb) => onBackgroundServiceFailed(cb),
  audio,
  settings: callSettings,
  deviceKind: () => deviceKind.value,
  openSettings: () => ui.openSettingsSub('call'),
  now: () => performance.now(),
  buffered: () => client.sendBuffered,
});

/** プラグイン向けの disnans.call */
export const callApi: Disnans.Call = createCallApi(call, (id) => {
  const u = client.user(id);
  return u ? toPluginUser(u) : { id, login_name: '', display_name: viewTexts.unknownUser, avatar_url: null };
});

let started = false;

/** サーバーの call.* イベントを通話に流し始める（1回だけ） */
export function startCall(): void {
  if (started) return;
  started = true;
  client.subscribe((ev) => call.onServerEvent(ev));
  client.subscribeLink((up) => call.onLink(up));
  // チャットの接続を作り直すと通話が切れるのは、同じ接続を使う従来の通話だけ。
  client.setInCall(() => !call.nativeOwned && call.joined);
  if (call.nativeOwned) {
    // 回復中・参加中のネイティブの通話を採用する（読むだけ。参加も開始もしない）。接続先が変わったら止める
    void call.adoptNative();
    onServerChange(() => call.onServerChanged());
  }
  // すでに接続していて参加者の一覧を取りこぼしていることはない（接続のたびにサーバーが送る）
}
