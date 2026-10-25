import type { TransferItem, TransferOp } from '../sharedTransfer';

/**
 * 共有フォルダの画面の、アプリ内の切り取り・コピーのバッファ（OS のクリップボードとは別。文字・画像の貼り付けには使わない）。
 * 中身はパスだけ（実体は共有フォルダにある）。切り取りは貼り付けたら外す。コピーは何度でも貼り付けられる。
 */
class ExplorerBuffer {
  mode = $state<TransferOp | null>(null);
  items = $state<TransferItem[]>([]);
  /**
   * コピー・切り取りのときに OS のクリップボードへ書いた文字（項目のパス）。書けなかったら null。
   * 貼り付けのとき、クリップボードがまだこの文字なら、このバッファを貼る（ほかでコピーし直していれば、そちらを貼る）
   */
  clipText = $state<string | null>(null);

  get empty(): boolean {
    return this.items.length === 0;
  }

  /** 切り取り（move）かコピー（copy）で入れ替える */
  set(mode: TransferOp, items: TransferItem[]): void {
    this.mode = mode;
    this.items = [...items];
    this.clipText = null;
  }

  /** 貼り付けたものを外す（切り取りのとき）。残りが無ければ空にする */
  remove(paths: readonly string[]): void {
    this.items = this.items.filter((i) => !paths.includes(i.path));
    if (this.items.length === 0) this.mode = null;
  }

  clear(): void {
    this.mode = null;
    this.items = [];
    this.clipText = null;
  }

  /** 切り取りの途中か（一覧で薄く出すため） */
  isCut(path: string): boolean {
    return this.mode === 'move' && this.items.some((i) => i.path === path);
  }
}

export const explorerBuffer = new ExplorerBuffer();
