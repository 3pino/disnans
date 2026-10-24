import { SvelteSet } from 'svelte/reactivity';

/**
 * 共有フォルダの一覧の複数選択（選択モード）。長押し・メニューの「選択」で入る。フォルダを変えたら外す。
 * 中身はパス（項目の種類は一覧から引く）。選択モードの中では、行を押すと開かずに選び直す。
 */
class ExplorerSelection {
  /** 選択モード（項目に印を出し、行を押すと選ぶ） */
  active = $state(false);
  private set = new SvelteSet<string>();

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
    this.active = true;
    this.set.add(path);
  }

  /** 選択モードに入る（項目は選ばない） */
  enter(): void {
    this.active = true;
  }

  /** 選ぶ・選ばないを切り替える（選択モードのまま） */
  toggle(path: string): void {
    if (this.set.has(path)) this.set.delete(path);
    else this.set.add(path);
  }

  /** 与えた項目をすべて選ぶ（選択モードに入る） */
  selectAll(paths: readonly string[]): void {
    this.active = true;
    for (const p of paths) this.set.add(p);
  }

  /** 選択モードを終え、選びを外す */
  clear(): void {
    this.active = false;
    this.set.clear();
  }
}

export const explorerSelection = new ExplorerSelection();
