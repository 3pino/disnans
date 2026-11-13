// 短い振動（操作の合図）。Tauri の Android では、ネイティブの振動を使う（notifier プラグインの vibrate コマンド）。
// WebView の navigator.vibrate は、押している最中は user activation が無く拒否されることがあるため。
// それ以外は navigator.vibrate（対応していない環境では何もしない）。ネイティブの呼び出しが失敗しても握りつぶす
import { isAndroid, isTauri } from './platform';
import { invokeNative } from './nativeInvoke';
import { deviceSettings } from './stores/deviceSettings.svelte';
import { onForeground } from './foreground';

/** Android のネイティブ振動のコマンド（Rust の notifier プラグイン。引数は { ms }） */
export const VIBRATE_COMMAND = 'plugin:notifier|vibrate';
export const SET_HAPTICS_COMMAND = 'plugin:notifier|set_haptics_enabled';

/** WebView 自身の長押しの振動も、同じ設定で切り替える。起動時・設定変更・前面復帰時に同期する。 */
export function startHapticsPreferences(): () => void {
  if (!isTauri() || !isAndroid()) return () => {};
  let disposed = false;
  let generation = 0;
  let queue = Promise.resolve();
  const push = () => {
    const mine = ++generation;
    queue = queue.then(async () => {
      if (disposed || mine !== generation) return;
      if (disposed || mine !== generation) return;
      await invokeNative('notifier', 'set_haptics_enabled', { enabled: deviceSettings.hapticsEnabled });
    }).catch(() => {
      // 設定変更・前面復帰で再同期する。通知の設定は触らない。
      console.warn('[haptics] preference_sync_failed');
    });
  };
  const off = deviceSettings.subscribe(push);
  const offForeground = onForeground(push);
  push();
  return () => {
    disposed = true;
    generation++;
    off();
    offForeground();
  };
}

export function vibrate(ms: number): void {
  if (isAndroid() && !deviceSettings.hapticsEnabled) return;
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
    // import を待つ間にオフにした場合も、遅れて振動させない。
    await import('@tauri-apps/api/core');
    if (deviceSettings.hapticsEnabled) await invokeNative('notifier', 'vibrate', { ms });
  } catch {
    // ネイティブの振動が使えない（コマンドが無い・失敗）ときは、振動しないだけ
  }
}
