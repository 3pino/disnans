import { capabilities, isTauri } from '../platform';
import { isNewer } from '../semver';

const REPO = '3pino/disnans';
export const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'latest' }
  | { kind: 'available'; version: string; notes: string | null }
  | { kind: 'permission' }
  | { kind: 'downloading'; downloaded: number; total: number | null }
  | { kind: 'installing' }
  | { kind: 'error'; message: string };

type Progress = { downloaded: number; total: number | null };

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class Updater {
  version = $state<string | null>(null);
  state = $state<UpdateState>({ kind: 'idle' });
  /** Tauri 版（Windows・Linux・Android）だけがアップデートできる */
  readonly supported = isTauri();
  private apply: (() => Promise<void>) | null = null;
  private busy = false;

  async loadVersion(): Promise<void> {
    if (!this.supported || this.version) return;
    try {
      const { getVersion } = await import('@tauri-apps/api/app');
      this.version = await getVersion();
    } catch {
      // 表示できないだけ
    }
  }

  /** quiet なら（定期の確認）、失敗しても画面にエラーを出さず、待機中に戻す */
  async check(opts: { quiet?: boolean } = {}): Promise<void> {
    if (!this.supported || this.busy) return;
    this.busy = true;
    try {
      await this.refresh(false);
    } catch (e) {
      this.state = opts.quiet ? { kind: 'idle' } : { kind: 'error', message: errorMessage(e) };
    } finally {
      this.busy = false;
    }
  }

  async install(): Promise<void> {
    if (!this.supported || this.busy || (this.state.kind !== 'available' && this.state.kind !== 'permission')) return;
    this.busy = true;
    try {
      // 通知後に次の版が出ていることがある。古い URL や Update を使わず、
      // 許可画面から戻った場合も含め、押すたびに最新を確認してから取得する。
      await this.refresh(true);
      await this.apply?.();
    } catch (e) {
      this.state = { kind: 'error', message: errorMessage(e) };
    } finally {
      this.apply = null;
      this.busy = false;
    }
  }

  private async refresh(prepareInstall: boolean): Promise<void> {
    this.state = { kind: 'checking' };
    this.apply = null;
    await this.loadVersion();
    if (capabilities().updater === 'android') await this.checkAndroid(prepareInstall);
    else await this.checkDesktop(prepareInstall);
  }

  async openReleasePage(): Promise<void> {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(RELEASES_URL);
  }

  private async checkDesktop(prepareInstall: boolean): Promise<void> {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check({ headers: { 'Cache-Control': 'no-cache' } });
    if (!update) {
      this.state = { kind: 'latest' };
      return;
    }
    this.state = { kind: 'available', version: update.version, notes: update.body ?? null };
    if (!prepareInstall) {
      await update.close();
      return;
    }
    this.apply = async () => {
      try {
        await this.installDesktop(update);
      } finally {
        // インストーラー側で既に解放されている場合は無視する。
        await update.close().catch(() => {});
      }
    };
  }

  private async installDesktop(update: import('@tauri-apps/plugin-updater').Update): Promise<void> {
    let downloaded = 0;
    let total: number | null = null;
    this.state = { kind: 'downloading', downloaded, total };
    await update.downloadAndInstall((ev) => {
      if (ev.event === 'Started') total = ev.data.contentLength ?? null;
      else if (ev.event === 'Progress') downloaded += ev.data.chunkLength;
      else if (ev.event === 'Finished') {
        this.state = { kind: 'installing' };
        return;
      }
      this.state = { kind: 'downloading', downloaded, total };
    });
    this.state = { kind: 'installing' };
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  }

  private async checkAndroid(prepareInstall: boolean): Promise<void> {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
    });
    if (res.status === 404) throw new Error('リリースが見つかりません');
    if (!res.ok) throw new Error(`GitHub に接続できません (HTTP ${res.status})`);
    const rel = (await res.json()) as {
      tag_name: string;
      body: string | null;
      assets: { name: string; browser_download_url: string }[];
    };
    const latest = rel.tag_name.replace(/^v/, '');
    if (!this.version || !isNewer(latest, this.version)) {
      this.state = { kind: 'latest' };
      return;
    }
    const apks = rel.assets.filter((a) => a.name.toLowerCase().endsWith('.apk'));
    const apk =
      apks.find((a) => /universal/i.test(a.name)) ?? apks.find((a) => /arm64|aarch64/i.test(a.name)) ?? apks[0];
    if (!apk) throw new Error(`v${latest} に APK がありません`);

    this.state = { kind: 'available', version: latest, notes: rel.body };
    if (!prepareInstall) return;
    const notes = rel.body;
    this.apply = async () => {
      const { invoke, Channel } = await import('@tauri-apps/api/core');
      const { granted } = await invoke<{ granted: boolean }>('plugin:apk-updater|can_install');
      if (!granted) {
        this.state = { kind: 'permission' };
        await invoke('plugin:apk-updater|open_install_settings');
        return;
      }
      this.state = { kind: 'downloading', downloaded: 0, total: null };
      const onProgress = new Channel<Progress>();
      onProgress.onmessage = (p) => {
        if (this.state.kind === 'downloading') this.state = { kind: 'downloading', ...p };
      };
      await invoke('plugin:apk-updater|download_and_install', { url: apk.browser_download_url, onProgress });
      this.state = { kind: 'installing' };
      // インストールを中断されたときにもう一度押せるようにする
      setTimeout(() => {
        if (this.state.kind === 'installing') this.state = { kind: 'available', version: latest, notes };
      }, 4000);
    };
  }
}

export const updater = new Updater();
