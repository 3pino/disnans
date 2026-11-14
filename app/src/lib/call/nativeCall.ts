// 通話の、Android（Tauri の notifier プラグイン）側との橋渡し。Android 以外では何もしない。
// （[call] の console は lib/diagLog.ts が、ほかの行と一緒に診断ログと logcat に残す）
// - WebView は、通話の参加中は裏でも動かし続ける（参加のときに伝える）。

import { isAndroid, isTauri } from '../platform';
import { invokeNative } from '../nativeInvoke';

function nativeAvailable(): boolean {
  return isTauri() && isAndroid();
}

/** 通話の参加時に呼ぶ（WebView を裏でも動かし続ける）。失敗しても通話は続ける */
export function setKeepWebViewResumed(): void {
  if (!nativeAvailable()) return;
  invokeNative('notifier', 'set_keep_web_view', { enabled: true }).catch((e) => console.warn('[call] WebView の設定を送れませんでした', e));
}
