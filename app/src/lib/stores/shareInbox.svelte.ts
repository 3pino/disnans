// 共有（Android の共有メニュー）で受け取ったファイルと文章を、入力欄が拾うまで置いておく。
// 共有を受け取る側は push() を呼ぶだけ。メインチャットの Composer が take() で受け取り、自分の添付と本文に加える。

class ShareInbox {
  files = $state<File[]>([]);
  text = $state<string>('');

  push(files: File[], text = ''): void {
    if (files.length > 0) this.files = [...this.files, ...files];
    if (text) this.text = this.text ? `${this.text}\n${text}` : text;
  }

  /** 置いてあるものを取り出し、箱を空にする */
  take(): { files: File[]; text: string } {
    const got = { files: [...this.files], text: this.text };
    this.files = [];
    this.text = '';
    return got;
  }
}

export const shareInbox = new ShareInbox();
