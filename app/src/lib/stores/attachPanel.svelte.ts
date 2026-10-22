/**
 * 入力欄の上の「ファイルを追加」パネル（カメラ・画像・ファイル・最新の画像）の開閉。
 * コマンド（パレット・＋メニュー）から開き、入力欄（Composer）が表示する
 */
class AttachPanel {
  open = $state(false);

  show(): void {
    this.open = true;
  }

  hide(): void {
    this.open = false;
  }

  toggle(): void {
    this.open = !this.open;
  }
}

export const attachPanel = new AttachPanel();
