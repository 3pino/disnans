import { ui } from './stores/ui.svelte';

export function notificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  return notificationSupported() ? Notification.permission : 'unsupported';
}

export async function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!notificationSupported()) return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

function isViewing(threadId: string | null): boolean {
  if (document.visibilityState !== 'visible') return false;
  if (threadId) return ui.panel?.kind === 'thread' && ui.panel.id === threadId;
  return !ui.isMobile || ui.tab === 'chat';
}

/** サーバーの notify イベントを表示する */
export function showNotification(title: string, body: string, threadId: string | null, _messageId: string | null): void {
  if (isViewing(threadId)) return;
  const open = () => {
    if (threadId) ui.openThread(threadId);
    else ui.tab = 'chat';
  };
  if (document.visibilityState !== 'visible' && notificationPermission() === 'granted') {
    try {
      const n = new Notification(title, { body, tag: threadId ?? 'main' });
      n.onclick = () => {
        window.focus();
        open();
        n.close();
      };
      return;
    } catch {
      // Android の WebView などでは使えないので、アプリ内表示にする
    }
  }
  ui.toast(`${title}: ${body}`, 'info', threadId ? { label: '開く', run: open } : undefined, 8000);
}
