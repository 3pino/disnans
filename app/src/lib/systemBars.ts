import { isTauri } from './config';

function isAndroid(): boolean {
  return /android/i.test(navigator.userAgent);
}

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
