import { isAndroid } from './platform';

// 共有フォルダへの貼り付けで使う、OS のクリップボードの文字と「何があるか」。画像は clipboardImage.ts の readClipboardImage。
// - Android: notifier の clipboard_peek（説明だけ見るので「貼り付けました」の通知は出ない）・clipboard_text
// - デスクトップ（Windows・Linux）: Rust のクリップボード（プラグイン）

/** クリップボードに文字・画像があるか。unknown は確かめられない（押したときに読む） */
export type ClipboardPeek = { text: boolean; image: boolean } | 'unknown';

export async function peekClipboard(): Promise<ClipboardPeek> {
  try {
    if (isAndroid()) {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<{ text: boolean; image: boolean }>('plugin:notifier|clipboard_peek');
    }
    const { readImage, readText } = await import('@tauri-apps/plugin-clipboard-manager');
    const text = await readText().then((t) => t !== '', () => false);
    let image = false;
    try {
      await (await readImage()).close();
      image = true;
    } catch {
      // 画像が無い
    }
    return { text, image };
  } catch {
    return 'unknown';
  }
}

/** クリップボードの文字。無い・読めないときは null */
export async function readClipboardText(): Promise<string | null> {
  try {
    if (isAndroid()) {
      const { invoke } = await import('@tauri-apps/api/core');
      const res = await invoke<{ text: string } | null>('plugin:notifier|clipboard_text');
      return res?.text || null;
    }
    const { readText } = await import('@tauri-apps/plugin-clipboard-manager');
    return (await readText()) || null;
  } catch {
    return null;
  }
}

/** 貼り付けた文字から作るファイルの名前（clipboard-20261025-061230.txt） */
export function clipboardTextName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `clipboard-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.txt`;
}
