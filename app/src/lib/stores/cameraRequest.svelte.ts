/**
 * 「写真を撮る」の依頼（コマンドパレット・＋メニューから）。チャットの入力欄（Composer）が取り出して、カメラを開く。
 * 依頼は1回ずつ。取り出されるまで残る（チャットを開いたときに開く）
 */
class CameraRequest {
  pending = $state(false);

  request(): void {
    this.pending = true;
  }

  /** 依頼があれば取り出して true（取り出すと依頼は消える） */
  take(): boolean {
    const was = this.pending;
    this.pending = false;
    return was;
  }
}

export const cameraRequest = new CameraRequest();
