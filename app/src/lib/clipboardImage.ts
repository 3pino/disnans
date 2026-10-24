import { isAndroid, isLinuxDesktop, isTauri } from './platform';
import { base64ToBytes } from './recentImagesNative';

/** Web の Clipboard API で読む画像の形式（この順で探す） */
const WEB_IMAGE_TYPES = ['image/png', 'image/webp', 'image/jpeg', 'image/gif'];

/**
 * クリップボードの画像を File にする（Linux の Tauri のみ）。形式は WebP（送る画像の標準）。WebP を作れなければ PNG。
 * WebKitGTK では paste イベントの clipboardData.files が空になることがあるので、そのときの代わりに使う。
 * 画像が無ければ null。貼り付け（MessageInput）が使う。ほかの場所からは readClipboardImage を使う。
 */
export async function readNativeClipboardImage(): Promise<File | null> {
  if (!isLinuxDesktop()) return null;
  return readRustClipboardImage();
}

/**
 * 「ファイルを追加」パネルの「クリップボードの画像」。画像が無ければ null。
 * 開くたびに 1 回読む。Tauri（Android・デスクトップ）では、画像が無い（null）ことが答えで、Web の経路には落とさない
 * （WebView の navigator.clipboard.read は許可の表示を出しうるため、開くたびに出ないように）。
 * - Android: notifier の clipboard_image。コマンドが無い・失敗したときだけ Web の経路
 * - デスクトップ（Windows・Linux）: Rust のクリップボード（プラグイン）。失敗は null
 * - ブラウザ: navigator.clipboard.read()（許されなければ null）
 */
export async function readClipboardImage(): Promise<File | null> {
  if (isTauri()) {
    if (isAndroid()) {
      try {
        return await readAndroidClipboardImage();
      } catch {
        return readWebClipboardImage();
      }
    }
    return readRustClipboardImage().catch(() => null);
  }
  return readWebClipboardImage();
}

/** Android のクリップボードの画像（notifier の clipboard_image → {name, mime, data}、無ければ null） */
async function readAndroidClipboardImage(): Promise<File | null> {
  const { invoke } = await import('@tauri-apps/api/core');
  const res = await invoke<{ name: string; mime: string; data: string } | null>('plugin:notifier|clipboard_image');
  if (!res) return null;
  return new File([base64ToBytes(res.data)], res.name || `clipboard-${Date.now()}`, { type: res.mime, lastModified: Date.now() });
}

/** Rust のクリップボードから画像を読む（プラグイン。デスクトップのみ）。画像が無ければ null */
async function readRustClipboardImage(): Promise<File | null> {
  const { readImage } = await import('@tauri-apps/plugin-clipboard-manager');
  let img;
  try {
    img = await readImage();
  } catch {
    // 画像が無い（テキストなど）、または許可が無い
    return null;
  }
  try {
    const { width, height } = await img.size();
    const { blob, type } = await rgbaToImage(await img.rgba(), width, height);
    const ext = type === 'image/webp' ? 'webp' : 'png';
    return new File([blob], `clipboard-${Date.now()}.${ext}`, { type, lastModified: Date.now() });
  } finally {
    await img.close();
  }
}

/** Web の Clipboard API で画像を読む。API が無い・許されない・画像が無いときは null */
async function readWebClipboardImage(): Promise<File | null> {
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (!clip || typeof clip.read !== 'function') return null;
  let items: ClipboardItems;
  try {
    items = await clip.read();
  } catch {
    return null;
  }
  for (const item of items) {
    const type = WEB_IMAGE_TYPES.find((t) => item.types.includes(t));
    if (!type) continue;
    try {
      const blob = await item.getType(type);
      const ext = type === 'image/jpeg' ? 'jpg' : type.slice('image/'.length);
      return new File([blob], `clipboard-${Date.now()}.${ext}`, { type, lastModified: Date.now() });
    } catch {
      return null;
    }
  }
  return null;
}

/** RGBA の画素を画像にする（キャンバス経由）。WebP を作れればそれ、作れなければ PNG */
async function rgbaToImage(rgba: Uint8Array<ArrayBuffer>, width: number, height: number): Promise<{ blob: Blob; type: string }> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('画像を変換できませんでした');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  const toBlob = (type: string) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.9));
  const webp = await toBlob('image/webp');
  if (webp?.type === 'image/webp') return { blob: webp, type: 'image/webp' };
  const png = await toBlob('image/png');
  if (!png) throw new Error('画像に変換できませんでした');
  return { blob: png, type: 'image/png' };
}
