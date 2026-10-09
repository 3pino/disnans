import { isAndroid, isTauri } from './config';

let last: boolean | null = null;

/**
 * Android のステータスバー・ナビゲーションバーのアイコンの明暗を、アプリのテーマに合わせる。
 * デスクトップやブラウザでは何もしない。
 */
export function syncSystemBars(dark: boolean): void {
  if (!isTauri() || !isAndroid() || last === dark) return;
  last = dark;
  void import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('plugin:system-bars|set_style', { dark }))
    .catch(() => {
      // 失敗しても見た目が少し悪いだけ。次の変更で再試行する
      last = null;
    });
}

/**
 * Android のナビゲーションバーを隠す・戻す。隠している間も、画面の下端からスワイプすると一時的に出る。
 * 隠すと env(safe-area-inset-bottom) が 0 になるので、下端の余白はそのまま追従する。
 * デスクトップやブラウザでは何もしない
 */
export async function setNavigationBarHidden(hidden: boolean): Promise<void> {
  if (!isTauri() || !isAndroid()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('plugin:system-bars|set_navigation_bar_hidden', { hidden });
}
