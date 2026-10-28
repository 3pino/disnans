// ゴミ箱の状態ストア（一覧の取得・無効化・エントリの削除）
// 世代（gen）で stale レスポンスを破棄、pendingReload で loading 中の invalidate を coalesce する:
//   loading 中に invalidate → gen 進行 + pendingReload=true → 完了後に 1 回だけ再 load
// open フラグは TrashView mount 時に FileExplorer がセット、invalidate 時の即再取得判断に使う
// サーバー変更（onServerChange）→ reset() で前サーバーの一覧を新サーバーへ流用しない
import type { SharedTrashEntry } from '../protocol/SharedTrashEntry';
import { sharedApi } from '../transport/shared';
import { attachmentActionText } from '../fileLink';
import { onServerChange } from '../config';

export type TrashState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; entries: SharedTrashEntry[] }
  | { kind: 'error'; message: string };

class ExplorerTrashState {
  state = $state<TrashState>({ kind: 'idle' });
  /** TrashView が表示されているか（FileExplorer からセット）。invalidate 時の即再取得を判断する */
  open = $state(false);
  /** 単調増加する世代。進めると飛んでいるリクエストのレスポンスを破棄する */
  private gen = 0;
  /** reset 前の取得が、新しい取得の再読み込みフラグを消費しないための識別子 */
  private loadSerial = 0;
  /** loading 中に invalidate が届いたとき、完了後にもう 1 回 load するフラグ */
  private pendingReload = false;

  /**
   * ゴミ箱の一覧を取得する。すでに loading 中なら何もしない（同時並列リクエストを防ぐ）。
   * loading 中に invalidate が届いた場合は pendingReload が立っているので、完了後に再取得する。
   */
  async load(): Promise<void> {
    if (this.state.kind === 'loading') return;
    const myGen = ++this.gen;
    const serial = ++this.loadSerial;
    this.pendingReload = false; // この load() 開始時点の pending を消費
    this.state = { kind: 'loading' };
    try {
      const entries = await sharedApi.trashList();
      if (myGen !== this.gen) {
        // 世代が変わった（reset / invalidate で gen が進んだ）→ 古い結果を捨てる
        this._afterLoad(serial);
        return;
      }
      this.state = { kind: 'ok', entries };
    } catch (e) {
      if (myGen !== this.gen) {
        this._afterLoad(serial);
        return;
      }
      this.state = { kind: 'error', message: attachmentActionText(e) };
    }
    this._afterLoad(serial);
  }

  /** load 完了（成功・失敗・stale）のあと、pendingReload があれば 1 回だけ再取得する */
  private _afterLoad(serial: number): void {
    if (serial !== this.loadSerial || !this.pendingReload) return;
    this.pendingReload = false;
    if (this.open) {
      this.state = { kind: 'idle' };
      void this.load();
    } else {
      this.state = { kind: 'idle' };
    }
  }

  /**
   * files.changed で呼ばれる（client.svelte.ts が配線）。
   * loading 中 → gen 進行 + pendingReload=true（完了後に再取得）
   * open + 非 loading → 即 idle に戻して再取得
   * closed + 非 loading → idle（次回 open 時に取得）
   * 短時間の連続 invalidate は pendingReload=true のまま coalesce される（並列リクエスト不可）
   */
  invalidate(): void {
    this.gen++; // 飛んでいるリクエストを失効
    if (this.state.kind === 'loading') {
      this.pendingReload = true;
    } else if (this.open) {
      this.state = { kind: 'idle' };
      void this.load();
    } else {
      this.state = { kind: 'idle' };
    }
  }

  /** 復元・完全削除が成功したあとに呼ぶ。一覧からそのエントリを外す */
  removeEntry(id: string): void {
    if (this.state.kind === 'ok') {
      this.state = { kind: 'ok', entries: this.state.entries.filter((e) => e.id !== id) };
    }
  }

  /**
   * サーバー変更・パネルを閉じたときに呼ぶ。
   * gen を進めて飛んでいるリクエストを失効させ、pendingReload もリセット。
   */
  reset(): void {
    this.gen++;
    this.loadSerial++;
    this.pendingReload = false;
    this.state = { kind: 'idle' };
    this.open = false;
  }
}

export const explorerTrash = new ExplorerTrashState();

// サーバーが変わったら前サーバーの一覧を捨てる（新サーバーへ流用しない）
onServerChange(() => explorerTrash.reset());
