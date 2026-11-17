// アプリのアップデートの「仕組み」（Tauri のアップデーター・APK の取得・GitHub のリリース）を、土台の UpdateBackend へつなぐ。
// 土台（@3pino/app-kit-web/updater）は状態の機械だけ持つ。リポジトリ名はここで決める。
import type { UpdateBackend } from '@3pino/app-kit-web/updater';
import { capabilities } from './platform';

const REPO = '3pino/disnans';
export const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;

export function tauriUpdateBackend(): UpdateBackend {
  return {
    kind: () => (capabilities().updater === 'android' ? 'android' : 'desktop'),
    async version() {
      const { getVersion } = await import('@tauri-apps/api/app');
      return getVersion();
    },
    async checkDesktop() {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check({ headers: { 'Cache-Control': 'no-cache' } });
      return update ?? null;
    },
    async relaunch() {
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    },
    async fetchLatestAndroid() {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json' },
        cache: 'no-store',
      });
      if (res.status === 404) throw new Error('リリースが見つかりません');
      if (!res.ok) throw new Error(`GitHub に接続できません (HTTP ${res.status})`);
      return (await res.json()) as Awaited<ReturnType<UpdateBackend['fetchLatestAndroid']>>;
    },
    async canInstallAndroid() {
      const { invoke } = await import('@tauri-apps/api/core');
      const { granted } = await invoke<{ granted: boolean }>('plugin:apk-updater|can_install');
      return granted;
    },
    async openInstallSettings() {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('plugin:apk-updater|open_install_settings');
    },
    async downloadAndInstallAndroid(url, onProgress) {
      const { invoke, Channel } = await import('@tauri-apps/api/core');
      const channel = new Channel<{ downloaded: number; total: number | null }>();
      channel.onmessage = onProgress;
      await invoke('plugin:apk-updater|download_and_install', { url, onProgress: channel });
    },
    async openReleasePage() {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(RELEASES_URL);
    },
  };
}
