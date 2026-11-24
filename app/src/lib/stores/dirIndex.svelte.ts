// フォルダの一覧の手元の写し（必要になったフォルダだけ読み、変わったら捨てる）。
// もとは共有の部品（@3pino/explorer-kit の DirIndex）。本体の共有フォルダの写し（sharedIndex）だけが使う。
import { SvelteMap } from 'svelte/reactivity';
import { parentOf } from '../sharedPath';

/** 読めなかった一覧を読み直すまでの時間（ms） */
const RETRY_MS = 5_000;

export type DirState<E> =
  | { kind: 'loading' }
  | { kind: 'ok'; entries: Map<string, E> }
  | { kind: 'missing' }
  | { kind: 'error'; message: string; at: number };

/** 変わった項目が、このフォルダの一覧を変えるか（項目そのもの・親・中身） */
export function affects(dir: string, changed: string): boolean {
  if (dir === changed || dir === parentOf(changed)) return true;
  return dir.startsWith(changed + '/');
}

export type DirIndexOptions<E> = {
  /** フォルダの中身を読む */
  list(dir: string): Promise<E[]>;
  /** 失敗が「そのフォルダが無い」か（無ければ、どの失敗も error） */
  isMissing?(e: unknown): boolean;
};

/**
 * フォルダの一覧の手元の写し。必要になったフォルダだけ読み、変わったら（invalidate）その写しを捨てる。
 * 見ている側は、描画の中で state() を読み、無ければ ensure() で読み始める。
 * 読めなかったものは、次に必要になったとき（ensure）もう一度読む。
 */
export class DirIndex<E extends { name: string } = { name: string }> {
  protected dirs = new SvelteMap<string, DirState<E>>();
  /** 読み直しの世代。読んでいる途中で変わったら、その結果は捨てる */
  private gen = new Map<string, number>();

  constructor(private readonly options: DirIndexOptions<E>) {}

  /** フォルダの一覧の今の状態（なければ undefined。描画の中で読むと、捨てられたときに見ている側が気付く） */
  state(dir: string): DirState<E> | undefined {
    return this.dirs.get(dir);
  }

  /** フォルダの一覧が手元になければ読む（読み込み中は何もしない） */
  ensure(dir: string): void {
    const st = this.dirs.get(dir);
    // 読めなかったものは RETRY_MS のあと読み直す（一時的な失敗が、再読み込みまで続かないように）
    if (st !== undefined && !(st.kind === 'error' && Date.now() - st.at >= RETRY_MS)) return;
    this.load(dir);
  }

  private load(dir: string): void {
    const g = this.gen.get(dir) ?? 0;
    // 読み直しの間も、前の中身（ok）は見せたままにする（捨てると、見ている側が一度「読み込み中」になり、描画が縮んで位置がずれる）
    if (this.dirs.get(dir)?.kind !== 'ok') this.dirs.set(dir, { kind: 'loading' });
    this.options.list(dir).then(
      (list) => {
        if ((this.gen.get(dir) ?? 0) !== g) return;
        const entries = new Map(list.map((e) => [e.name, e]));
        this.dirs.set(dir, { kind: 'ok', entries });
        this.loaded(dir, entries);
      },
      (e: unknown) => {
        if ((this.gen.get(dir) ?? 0) !== g) return;
        const missing = this.options.isMissing?.(e) ?? false;
        if (missing) {
          this.dirs.set(dir, { kind: 'missing' });
          return;
        }
        // 一時的な失敗で、読めていた中身を消さない（次の変更・再接続で読み直す）
        if (this.dirs.get(dir)?.kind === 'ok') return;
        this.dirs.set(dir, { kind: 'error', message: e instanceof Error ? e.message : String(e), at: Date.now() });
      },
    );
  }

  /** 一覧を読み終えたとき（継いだ側が、読めた中身を使う） */
  protected loaded(_dir: string, _entries: Map<string, E>): void {}

  /** 手元の写しをすべて捨てる（接続先が変わったとき）。読んでいる途中の結果も、世代を進めて捨てる */
  clear(): void {
    for (const dir of this.dirs.keys()) this.gen.set(dir, (this.gen.get(dir) ?? 0) + 1);
    this.dirs.clear();
  }

  /** 変わった項目に関わるフォルダの写しを読み直す。読めていた中身は読み終わるまで見せたままにする（捨てない） */
  invalidate(changed: string): void {
    for (const dir of [...this.dirs.keys()]) {
      if (!affects(dir, changed)) continue;
      this.reread(dir);
    }
  }

  /** 全部を読み直す（再接続のあと。読めていた中身は読み終わるまで見せたままにする） */
  refresh(): void {
    for (const dir of [...this.dirs.keys()]) this.reread(dir);
  }

  /** 読んでいる途中の結果を捨て、読めていたものは背景で読み直す。読めていないもの（読み込み中・missing・error）は次の ensure で読む */
  private reread(dir: string): void {
    this.gen.set(dir, (this.gen.get(dir) ?? 0) + 1);
    if (this.dirs.get(dir)?.kind === 'ok') this.load(dir);
    else this.dirs.delete(dir);
  }
}
