/**
 * 写真を撮る（カメラのモーダルで使う）。映像の1コマを JPEG にして、添付のファイルにする。
 * 端末の違い（Android の WebView・WebView2・WebKitGTK）は getUserMedia の許可の表示だけで、ここでは扱わない。
 */

/** 写真のファイル名（写真-年月日-時分秒.jpg。ローカルの時刻） */
export function photoFileName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `写真-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.jpg`;
}

/** 映像の今の1コマを JPEG（品質 0.9）にする。映像の大きさがまだ無いときは例外 */
export async function captureJpeg(video: HTMLVideoElement): Promise<Blob> {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (w <= 0 || h <= 0) throw new Error('映像がまだありません');
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('画像を描けませんでした');
  ctx.drawImage(video, 0, 0, w, h);
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('写真を作れませんでした'))), 'image/jpeg', 0.9),
  );
}

/** カメラを開けなかったときの文言（許可・機器の有無で分ける） */
export function cameraErrorText(e: unknown): string {
  const name = e instanceof Error ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'カメラの使用が許可されていません';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return 'カメラが見つかりません';
  return 'カメラを起動できませんでした';
}
