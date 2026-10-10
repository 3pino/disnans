import { isLinuxDesktop } from './config';

/**
 * クリップボードの画像を File にする（Linux の Tauri のみ）。形式は WebP（送る画像の標準）。WebP を作れなければ PNG。
 * WebKitGTK では paste イベントの clipboardData.files が空になることがあるので、そのときの代わりに使う。
 * 画像が無ければ null。
 */
export async function readClipboardImage(): Promise<File | null> {
  if (!isLinuxDesktop()) return null;
  const { readImage } = await import('@tauri-apps/plugin-clipboard-manager');
  let img;
  try {
    img = await readImage();
  } catch {
    // 画像が無い（テキストなど）
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
