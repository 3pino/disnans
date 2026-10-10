import { isLinuxDesktop } from './config';

/**
 * クリップボードの画像を PNG の File にする（Linux の Tauri のみ）。
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
    const blob = await rgbaToPng(await img.rgba(), width, height);
    return new File([blob], `clipboard-${Date.now()}.png`, { type: 'image/png', lastModified: Date.now() });
  } finally {
    await img.close();
  }
}

/** RGBA の画素を PNG にする（キャンバス経由） */
async function rgbaToPng(rgba: Uint8Array<ArrayBuffer>, width: number, height: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('画像を変換できませんでした');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG に変換できませんでした'))), 'image/png'),
  );
}
