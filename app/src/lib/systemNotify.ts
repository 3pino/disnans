/**
 * システム通知の出し方と、押したときの動作を 1 か所にまとめる。
 *
 * 押したときは、どの環境でも同じ動作（呼び出し側の onOpen。チャットを表示する openTarget）:
 * - android: 常駐サービス（Kotlin）が出す。押すと notifier の open が来る（JS は送らない）
 * - desktop（Tauri の Windows・Linux）: Rust の desktop_notify が出す。押すと Rust がウィンドウを前面に出し、
 *   desktop-notification-clicked を送る（src-tauri/src/desktop_notify.rs）。プラグインの通知は押しても何もしないので使わない
 * - web（ブラウザー）: Notification API。通知ごとの onclick で、ウィンドウにフォーカスして開く
 */
export type SystemBackend = 'android' | 'desktop' | 'web';

export type SystemNote = { title: string; body: string };

/** 通知を押したときの動作（呼び出し側が渡す） */
export type OnOpen = () => void;

/** Rust が押したあとに送るイベント名（src-tauri/src/desktop_notify.rs の CLICKED_EVENT と同じ値） */
export const DESKTOP_CLICKED_EVENT = 'desktop-notification-clicked';
/** Rust に通知を出してもらうコマンド名（src-tauri/src/desktop_notify.rs の desktop_notify と同じ値） */
export const DESKTOP_NOTIFY_COMMAND = 'desktop_notify';

/**
 * 押したときの受け口を付ける（アプリの起動時に 1 回）。Web は通知ごとに onclick を付けるので、ここでは何もしない
 */
export async function listenSystemOpen(backend: SystemBackend, onOpen: OnOpen): Promise<void> {
  if (backend === 'android') {
    const { addPluginListener } = await import('@tauri-apps/api/core');
    await addPluginListener('notifier', 'open', () => onOpen());
  } else if (backend === 'desktop') {
    const { listen } = await import('@tauri-apps/api/event');
    await listen(DESKTOP_CLICKED_EVENT, () => onOpen());
  }
}

/**
 * システム通知を出す。出せたら true。Android は常駐サービスが出すので、ここでは出さない（false）。
 * デスクトップは Rust に頼む（失敗は記録だけする。同期の結果は true）
 */
export function sendSystemNote(backend: SystemBackend, note: SystemNote, onOpen: OnOpen): boolean {
  if (backend === 'android') return false;
  if (backend === 'desktop') {
    void invokeDesktopNotify(note).catch((e) => console.warn('デスクトップの通知に失敗', e));
    return true;
  }
  try {
    const n = new Notification(note.title, { body: note.body, tag: 'main' });
    n.onclick = () => {
      window.focus();
      onOpen();
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}

async function invokeDesktopNotify(note: SystemNote): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke(DESKTOP_NOTIFY_COMMAND, { title: note.title, body: note.body });
}
