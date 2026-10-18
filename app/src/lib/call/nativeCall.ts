// 通話の、Android（Tauri の notifier プラグイン）側との橋渡し。Android 以外では何もしない。
// - ログ: 通話の [call] の console を logcat にも出す（リリース版では WebView の console が見えないため）
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

function describe(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

let installed = false;

/**
 * console.info / warn / error のうち、先頭が "[call]" のものを logcat（タグ disnans）にも送る。
 * 1 回だけ入れる。Android 以外では何もしない。元の console の出力はそのまま残す。
 */
export function installCallLogForwarding(): void {
  if (installed || !nativeAvailable()) return;
  installed = true;
  for (const level of ['info', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      const first = args[0];
      if (typeof first !== 'string' || !first.startsWith('[call]')) return;
      const message = `${level} ${args.map(describe).join(' ')}`;
      call('log_call', { message }).catch(() => {});
    };
  }
}
