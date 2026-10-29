import { SvelteSet } from 'svelte/reactivity';

/**
 * 共有フォルダの一覧の複数選択。
 * - タッチ（Android など）: 長押し・メニューで選択モードに入る。0 件になると選択モードを終える。
 * - PC（Windows・Linux の Tauri。desktop）: 選択の操作は常に効いている（行を押すと選ぶ・外す）。0 件でも終わらない。
 *   0 件のときは通常の一覧（印・件数の表示なし）。選び・フォルダ移動・空きスペースで選びは外れるが、操作は残る。
 * 中身はパス（項目の種類は一覧から引く）。
 */
class ExplorerSelection {
  /** PC の操作（常に効く選択）。FileExplorer が、この端末の種類で決める */
  desktop = $state(false);
  /** 選択モード（タッチの長押し・すべて選ぶで入る。PC でも入るが、0 件で終わらない） */
  private mode = $state(false);
  private set = new SvelteSet<string>();

  /** 行を押すと選ぶ・外す（効いている）。PC は常に true。タッチは選択モードの間だけ */
  get active(): boolean {
    return this.desktop || this.mode;
  }

  /** 選んだ印や「N 件選択中」を出すか。PC は 1 件以上選んだときだけ（0 件は通常の一覧） */
  get showing(): boolean {
    return this.set.size > 0 || (!this.desktop && this.mode);
  }

  get count(): number {
    return this.set.size;
  }

  has(path: string): boolean {
    return this.set.has(path);
  }

  paths(): string[] {
    return [...this.set];
  }

  /** 選択モードに入り、この項目を選ぶ */
  start(path: string): void {
    this.mode = true;
    this.set.add(path);
  }

  /** 選択モードに入る（項目は選ばない） */
  enter(): void {
    this.mode = true;
  }

  /** 選ぶ・選ばないを切り替える。タッチでは最後の 1 件を外したら（0 件になったら）選択モードを終える（PC は続く） */
  toggle(path: string): void {
    if (this.set.has(path)) this.set.delete(path);
    else this.set.add(path);
    if (this.set.size === 0 && !this.desktop) this.mode = false;
  }

  /** 与えた項目をすべて選ぶ（選択モードに入る） */
  selectAll(paths: readonly string[]): void {
    this.mode = true;
    for (const p of paths) this.set.add(p);
  }

  /** 選びを外し、選択モードを終える（PC は操作が続く） */
  clear(): void {
    this.mode = false;
    this.set.clear();
  }
}

export const explorerSelection = new ExplorerSelection();
