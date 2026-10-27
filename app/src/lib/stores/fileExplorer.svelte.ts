import { parentOf } from '../sharedPath';
import { onServerChange } from '../config';
import { sharedIndex, type DirState } from './sharedIndex.svelte';

/**
 * 共有フォルダを見る画面の、いま開いているフォルダ。中身は sharedIndex（files.changed で読み直される）から引く。
 * パネルを開き直しても、最後に見ていたフォルダに戻る。
 */
class FileExplorerState {
  dir = $state('');
  /** 前に開いていたフォルダ（古い順）。「戻る」で 1 つずつ戻る（ブラウザーの戻ると同じ） */
  history = $state.raw<string[]>([]);

  /** フォルダを開く（一覧が手元になければ読む）。前のフォルダは「戻る」の履歴に積む */
  open(dir: string): void {
    if (dir !== this.dir) this.history = [...this.history, this.dir];
    this.dir = dir;
    sharedIndex.ensure(dir);
  }

  /** 前に開いていたフォルダへ戻る。履歴が無ければ false */
  back(): boolean {
    const prev = this.history.at(-1);
    if (prev === undefined) return false;
    this.history = this.history.slice(0, -1);
    this.dir = prev;
    sharedIndex.ensure(prev);
    return true;
  }

  /** 戻るの履歴を捨てる（パネルを開き直したとき） */
  forgetHistory(): void {
    this.history = [];
  }

  /** 1 つ上のフォルダへ。直下なら false（呼ぶ側でパネルを閉じるなどする） */
  up(): boolean {
    if (this.dir === '') return false;
    this.open(parentOf(this.dir));
    return true;
  }

  /** 今のフォルダの一覧の状態（描画の中で読む。無ければ読み始める必要がある） */
  get state(): DirState | undefined {
    return sharedIndex.state(this.dir);
  }

  /** 読み直す（失敗の「再読み込み」） */
  reload(): void {
    sharedIndex.invalidate(this.dir);
    sharedIndex.ensure(this.dir);
  }
}

export const fileExplorer = new FileExplorerState();
// 接続先が変わったら、旧サーバーの場所を開いたままにしない
onServerChange(() => {
  fileExplorer.dir = '';
  fileExplorer.forgetHistory();
});
