import { client } from '../stores/client.svelte';
import { ui } from '../stores/ui.svelte';
import { deviceKind } from '../deviceKind.svelte';
import { holdBackground } from '../plugins/background';
import { audio } from '../plugins/audio';
import { toPluginUser } from '../plugins/sessions';
import { createCallApi } from './api';
import { callSettings } from './settings.svelte';
import { CallStore } from './store.svelte';

/** アプリの通話（シングルトン）。画面・コマンド・プラグイン API が使う */
export const call = new CallStore({
  send: (ev) => void client.send(ev),
  meId: () => client.me?.id ?? '',
  nameOf: (id) => client.nameOf(id),
  toast: (text, kind) => ui.toast(text, kind),
  confirm: (o) => ui.confirm(o),
  hold: (opts) => holdBackground(opts),
  audio,
  settings: callSettings,
  deviceKind: () => deviceKind.value,
  openSettings: () => ui.openSettingsSub('call'),
  now: () => performance.now(),
});

/** プラグイン向けの disnans.call */
export const callApi: Disnans.Call = createCallApi(call, (id) => {
  const u = client.user(id);
  return u ? toPluginUser(u) : { id, login_name: '', display_name: '不明なユーザー', avatar_url: null };
});

let started = false;

/** サーバーの call.* イベントを通話に流し始める（1回だけ） */
export function startCall(): void {
  if (started) return;
  started = true;
  client.subscribe((ev) => call.onServerEvent(ev));
  // すでに接続していて参加者の一覧を取りこぼしていることはない（接続のたびにサーバーが送る）
}
