import { api } from '../api';
import { getServerUrl, isAndroid, isTauri } from '../config';
import { getItem, setItem } from '../storage';
import { ui } from './ui.svelte';

/**
 * 通知の出し方は環境ごとに違う。
 * - android: 常駐サービス（自前の notifier プラグイン）がサーバーにつなぎ、アプリが裏にあるときに出す
 * - desktop: 公式の notification プラグイン。ウィンドウにフォーカスがないときに出す
 * - web: ブラウザーの Notification API（開発用）
 *
 * どの環境でも、アプリを見ているときは、見ている場所以外の通知をアプリ内のトーストで出す。
 */
export type Backend = 'android' | 'desktop' | 'web';

export type Permission = NotificationPermission | 'unsupported';

/** Android の常駐サービスの状態（notifier プラグインの status） */
export type AndroidStatus = {
  enabled: boolean;
  running: boolean;
  connected: boolean;
  permission: boolean;
  batteryUnrestricted: boolean;
};

export type NotifyEvent = {
  title: string;
  body: string;
  threadId: string | null;
  sample: boolean;
};

const BACKGROUND_KEY = 'disnans.notify.background';

function detectBackend(): Backend {
  if (!isTauri()) return 'web';
  return isAndroid() ? 'android' : 'desktop';
}

async function invokeNotifier<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(`plugin:notifier|${cmd}`, args);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

class Notifications {
  readonly backend: Backend = detectBackend();
  /** システム通知の許可（desktop / web） */
  permission = $state<Permission>('default');
  /** Android の常駐サービスの状態 */
  android = $state<AndroidStatus | null>(null);
  /** Android: アプリを閉じていても通知を受け取るか（既定はオン） */
  background = $state(getItem(BACKGROUND_KEY) !== 'off');
  sendingSample = $state(false);

  private started = false;

  /** 接続を始めたあとに1回呼ぶ */
  async init(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      if (this.backend === 'android') await this.initAndroid();
      else if (this.backend === 'desktop') await this.initDesktop();
      else this.permission = 'Notification' in window ? Notification.permission : 'unsupported';
    } catch (e) {
      console.warn('通知の準備に失敗しました', e);
    }
  }

  private async initAndroid(): Promise<void> {
    const { addPluginListener } = await import('@tauri-apps/api/core');
    // 通知から開いたら、そのスレッド（なければチャット）を表示する
    await addPluginListener<{ threadId?: string | null }>('notifier', 'open', (t) => this.openTarget(t.threadId));
    const { target } = await invokeNotifier<{ target?: { threadId?: string | null } }>('take_launch_target');
    if (target) this.openTarget(target.threadId);

    if (this.background) {
      // 初回は通知の許可を求める（Android 13 以降。2回目以降は何も出ない）
      await invokeNotifier('request_permission');
      await invokeNotifier('start', { serverUrl: getServerUrl() });
    }
    await this.refresh();
  }

  private async initDesktop(): Promise<void> {
    const { isPermissionGranted, requestPermission } = await import('@tauri-apps/plugin-notification');
    this.permission = (await isPermissionGranted()) ? 'granted' : await requestPermission();
  }

  private openTarget(threadId: string | null | undefined): void {
    if (threadId) ui.openThread(threadId);
    else ui.tab = 'chat';
  }

  /** Android の常駐サービスの状態を読み直す */
  async refresh(): Promise<void> {
    if (this.backend !== 'android') return;
    try {
      this.android = await invokeNotifier<AndroidStatus>('status');
    } catch (e) {
      console.warn('通知の状態を取得できませんでした', e);
    }
  }

  async requestPermission(): Promise<void> {
    try {
      if (this.backend === 'android') {
        this.android = await invokeNotifier<AndroidStatus>('request_permission');
      } else if (this.backend === 'desktop') {
        const { requestPermission } = await import('@tauri-apps/plugin-notification');
        this.permission = await requestPermission();
      } else if (this.permission !== 'unsupported') {
        this.permission = await Notification.requestPermission();
      }
    } catch (e) {
      ui.toast(`通知の許可を求められませんでした: ${errorMessage(e)}`, 'error');
    }
  }

  async setBackground(on: boolean): Promise<void> {
    this.background = on;
    setItem(BACKGROUND_KEY, on ? 'on' : 'off');
    try {
      if (on) {
        await invokeNotifier('request_permission');
        await invokeNotifier('start', { serverUrl: getServerUrl() });
      } else {
        await invokeNotifier('stop');
      }
    } catch (e) {
      ui.toast(`切り替えられませんでした: ${errorMessage(e)}`, 'error');
    }
    await this.refresh();
  }

  async openBatterySettings(): Promise<void> {
    try {
      await invokeNotifier('open_battery_settings');
    } catch (e) {
      ui.toast(`設定を開けませんでした: ${errorMessage(e)}`, 'error');
    }
  }

  /** サーバー経由で自分に通知を送る（通知が届くまでの経路をまとめて確かめる） */
  async sendSample(): Promise<void> {
    this.sendingSample = true;
    try {
      await api.sampleNotification();
    } catch (e) {
      ui.toast(`送信できませんでした: ${errorMessage(e)}`, 'error');
    } finally {
      this.sendingSample = false;
    }
  }

  /** サーバーの notify イベントを表示する */
  show(ev: NotifyEvent): void {
    if (!ev.sample && this.isViewing(ev.threadId)) return;
    const visible = document.visibilityState === 'visible';

    if (this.backend === 'android') {
      // 常駐サービスが動いていれば、システム通知はそちらが出す
      const native = this.android?.running ?? false;
      if (ev.sample ? native : !visible) return;
      this.toast(ev);
      return;
    }

    const away = !visible || !document.hasFocus();
    if ((ev.sample || away) && this.permission === 'granted') {
      if (this.showSystem(ev)) return;
    }
    if (visible) this.toast(ev);
  }

  /** 通知の対象をいま画面で見ているか */
  private isViewing(threadId: string | null): boolean {
    if (document.visibilityState !== 'visible') return false;
    // デスクトップでは、ウィンドウが見えていても別のアプリを使っていれば見ていないとみなす
    if (this.backend !== 'android' && !document.hasFocus()) return false;
    if (threadId) return ui.panel?.kind === 'thread' && ui.panel.id === threadId;
    return ui.isMobile ? ui.tab === 'chat' : ui.tab !== 'settings';
  }

  private showSystem(ev: NotifyEvent): boolean {
    try {
      if (this.backend === 'desktop') {
        void import('@tauri-apps/plugin-notification').then(({ sendNotification }) =>
          sendNotification({ title: ev.title, body: ev.body }),
        );
        return true;
      }
      const n = new Notification(ev.title, { body: ev.body, tag: ev.threadId ?? 'main' });
      n.onclick = () => {
        window.focus();
        this.openTarget(ev.threadId);
        n.close();
      };
      return true;
    } catch {
      return false;
    }
  }

  private toast(ev: NotifyEvent): void {
    const open = ev.sample ? undefined : { label: '開く', run: () => this.openTarget(ev.threadId) };
    ui.toast(ev.body ? `${ev.title}: ${ev.body}` : ev.title, 'info', open, 8000);
  }
}

export const notifications = new Notifications();
