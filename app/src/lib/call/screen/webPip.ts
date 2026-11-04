/**
 * デスクトップの小窓（PiP）。映像を canvas に描き、その captureStream を <video> に入れて requestPictureInPicture する。
 * Android は本体の PiP（pipApi）を使うので、ここは使わない。
 */

export type WebPip = {
  /** 新しい画像を描く（大きさが変われば canvas を作り直す） */
  draw(img: HTMLImageElement): void;
  /** 閉じる（小窓を出ていれば戻す。資源を解放する） */
  close(): void;
};

/** 小窓が出せる環境か（DOM の機能で判定。実際に出せるかは start の結果で決まる） */
export function webPipAvailable(): boolean {
  return typeof document !== 'undefined' && (document as Document & { pictureInPictureEnabled?: boolean }).pictureInPictureEnabled === true && typeof HTMLCanvasElement !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
}

/** 小窓を始める。失敗したら例外（呼び出し側が知らせる） */
export async function startWebPip(first: HTMLImageElement, onLeave: () => void): Promise<WebPip> {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas');
  const fit = (img: HTMLImageElement) => {
    const w = Math.max(1, img.naturalWidth);
    const h = Math.max(1, img.naturalHeight);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  };
  fit(first);
  ctx.drawImage(first, 0, 0, canvas.width, canvas.height);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = canvas.captureStream(5);
  await video.play();
  const leave = () => onLeave();
  video.addEventListener('leavepictureinpicture', leave);
  await video.requestPictureInPicture();
  return {
    draw(img) {
      if (!img.naturalWidth) return;
      fit(img);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    },
    close() {
      video.removeEventListener('leavepictureinpicture', leave);
      if (document.pictureInPictureElement === video) void document.exitPictureInPicture().catch(() => {});
      const tracks = (video.srcObject as MediaStream | null)?.getTracks() ?? [];
      for (const t of tracks) t.stop();
      video.srcObject = null;
    },
  };
}
