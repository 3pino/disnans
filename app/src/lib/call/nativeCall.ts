// 通話の、Android（Tauri の notifier プラグイン）側との橋渡し。Android 以外では何もしない。
// （[call] の console は lib/diagLog.ts が、ほかの行と一緒に診断ログと logcat に残す）
// - WebView を裏でも動かし続けるかの設定（通話の参加時に決める。localStorage 'disnans.keepWebViewResumed'='0' で止める）

import { isAndroid, isTauri } from '../platform';

const NOTIFIER = 'plugin:notifier|';

function nativeAvailable(): boolean {
  return isTauri() && isAndroid();
}

async function call(cmd: string, args: Record<string, unknown>): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke(`${NOTIFIER}${cmd}`, args);
}

/** 実験用の逃げ道。'0' なら、通話中に裏へ回ったとき WebView を止めたままにする */
export function keepWebViewEnabled(): boolean {
  try {
    return localStorage.getItem('disnans.keepWebViewResumed') !== '0';
  } catch {
    return true;
  }
}

/** 通話の参加時に呼ぶ。失敗しても通話は続ける */
export function setKeepWebViewResumed(on: boolean): void {
  if (!nativeAvailable()) return;
  call('set_keep_web_view', { enabled: on }).catch((e) => console.warn('[call] WebView の設定を送れませんでした', e));
}
