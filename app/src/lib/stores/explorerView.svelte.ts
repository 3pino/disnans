import { parentOf } from '../sharedPath';
import { deviceSettings } from './deviceSettings.svelte';
import {
  inheritedDirView,
  parseDirViewMap,
  withDirView,
  type DirView,
  type DirViewMap,
  type ViewMode,
} from '../explorerDirs';
import type { SortKey, SortOrder } from '../fileExplorer';

// 共有フォルダの一覧の表示方法と並び順。フォルダごと・この端末だけの設定（デバイスの設定 `explorerDirs`。サーバーのこの端末の prefs に入り、キャッシュにも残る）。
// 決めていないフォルダは、いちばん近い上のフォルダの設定に従う（どこにも無ければ既定: 詳細・名前の昇順）。
// 読み書きは deviceSettings を通す（同期の順番・キャッシュ・取り込みはそこが持つ）。ここは同期の API と、表示の計算だけ。

export type { ViewMode, DirView };

class ExplorerView {
  private memoRaw: unknown = undefined;
  private memo: DirViewMap = {};

  /** 保存されている表示（deviceSettings の値を、読むたびに検証する。同じ値なら作り直さない） */
  private get map(): DirViewMap {
    const raw = deviceSettings.raw.explorerDirs;
    if (raw !== this.memoRaw) {
      this.memoRaw = raw;
      this.memo = parseDirViewMap(raw);
    }
    return this.memo;
  }

  /** このフォルダの表示（決めていなければ上のフォルダ、無ければ既定） */
  of(dir: string): DirView {
    return inheritedDirView(this.map, dir, parentOf);
  }

  setView(dir: string, view: ViewMode): void {
    this.put(dir, { ...this.of(dir), view });
  }

  setSort(dir: string, sortKey: SortKey, sortOrder: SortOrder): void {
    this.put(dir, { ...this.of(dir), sortKey, sortOrder });
  }

  /** 保存を消す（テスト用） */
  reset(): void {
    deviceSettings.set('explorerDirs', {});
  }

  private put(dir: string, v: DirView): void {
    // 変えたものを最後に置き、多すぎたら古いものから捨てる（lib/explorerDirs.ts）
    deviceSettings.set('explorerDirs', withDirView(this.map, dir, v));
  }
}

export const explorerView = new ExplorerView();
