// 短い振動（操作の合図）。Tauri の Android では、ネイティブの振動を使う（notifier プラグインの vibrate コマンド）。
// WebView の navigator.vibrate は、押している最中は user activation が無く拒否されることがあるため。
// それ以外は navigator.vibrate（対応していない環境では何もしない）。ネイティブの呼び出しが失敗しても握りつぶす
import { isAndroid, isTauri } from './platform';

/** Android のネイティブ振動のコマンド（Rust の notifier プラグイン。引数は { ms }） */
export const VIBRATE_COMMAND = 'plugin:notifier|vibrate';

export function vibrate(ms: number): void {
  if (isTauri() && isAndroid()) {
    void nativeVibrate(ms);
    return;
  }
  try {
    navigator.vibrate?.(ms);
  } catch {
    // 振動に対応しない環境（デスクトップなど）
  }
}

async function nativeVibrate(ms: number): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke(VIBRATE_COMMAND, { ms });
  } catch {
    // ネイティブの振動が使えない（コマンドが無い・失敗）ときは、振動しないだけ
  }
}
