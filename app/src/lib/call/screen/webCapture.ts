import type { ScreenSource } from './types';

export function stopTracks(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) { try { track.stop(); } catch { /* すでに終了 */ } }
}
export function isCaptureCancelled(error: unknown): boolean {
  return error instanceof Error && ['AbortError', 'NotAllowedError', 'PermissionDeniedError'].includes(error.name);
}
export function captureFailure(source: ScreenSource, error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (source === 'camera') {
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'カメラの使用が許可されていません。アプリの権限設定で許可してください';
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'カメラが見つかりません';
    if (name === 'NotReadableError') return 'カメラを開けません（ほかのアプリが使っているかもしれません）';
  }
  return source === 'camera' ? 'カメラを取得できませんでした' : '画面を取得できませんでした';
}

/** 制約を受け付けない場合だけ制約なしで試す。画面の拒否を勝手に別ソースへ替えない。 */
export async function pickVideo(source: ScreenSource, fps: number): Promise<MediaStream> {
  const media = navigator.mediaDevices;
  const pick = (video: MediaTrackConstraints | boolean) => source === 'camera'
    ? media.getUserMedia({ video, audio: false })
    : media.getDisplayMedia({ video, audio: false });
  try { return await pick({ frameRate: { ideal: fps, max: 30 } }); }
  catch (error) {
    if (!(error instanceof Error) || !['OverconstrainedError', 'TypeError', 'NotSupportedError'].includes(error.name)) throw error;
    return pick(true);
  }
}

export async function switchableCamera(): Promise<boolean> {
  try {
    const media = navigator.mediaDevices;
    if (!media?.getSupportedConstraints?.().facingMode) return false;
    if (!media.enumerateDevices) return true;
    return (await media.enumerateDevices()).filter((d) => d.kind === 'videoinput').length >= 2;
  } catch { return false; }
}

export async function oppositeCamera(stream: MediaStream, fps: number): Promise<MediaStream> {
  const current = stream.getVideoTracks()[0]?.getSettings?.().facingMode;
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { exact: current === 'environment' ? 'user' : 'environment' }, frameRate: { ideal: fps, max: 30 } },
  });
}
