import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import type { SharedEntry } from '../protocol/SharedEntry';
import { sharedApi } from '../transport/shared';
import { HttpError } from '../transport/http';
import { baseName, parentOf } from '../sharedPath';
import { onServerChange } from '../config';

/** 添付のフォルダ（`attachments/`） */
const ATTACHMENTS_DIR = 'attachments';

/** フォルダの一覧の状態（本文のファイルリンクを今の名前・有無で見分けるため） */
export type DirState =
  | { kind: 'loading' }
  | { kind: 'ok'; entries: Map<string, SharedEntry> }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

/** 本文のファイルリンク 1 つの状態 */
export type FileState =
  | { kind: 'loading' }
  | { kind: 'found'; entry: SharedEntry }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

/** 変わった項目が、このフォルダの一覧を変えるか（項目そのもの・親・中身） */
export function affects(dir: string, changed: string): boolean {
  if (dir === changed || dir === parentOf(changed)) return true;
  return dir.startsWith(changed + '/');
}

/**
 * 共有フォルダの一覧の手元の写し。本文のファイルリンク（`attachments/<名前>` など）を、いま在るかと、どの項目かを引くために使う。
 * 一覧は必要になったフォルダだけ読み、files.changed で親（と中身）を読み直す。
 * 読めなかったものは、次に必要になったとき（ensure）もう一度読む。
 */
export class SharedIndex {
  private dirs = new SvelteMap<string, DirState>();
  /** 読み直しの世代。読んでいる途中で変わったら、その結果は捨てる */
  private gen = new Map<string, number>();
  /** 自分が上げて、まだ投稿されていない添付（小文字のパス）。一覧にはまだ無いので、見つからないとは出さず読み込み中にする */
  private unposted = new SvelteSet<string>();

  /** フォルダの一覧の今の状態（なければ undefined。描画の中で読むと、捨てられたときに見ている側が気付く） */
  state(dir: string): DirState | undefined {
    return this.dirs.get(dir);
  }

  /** フォルダの一覧が手元になければ読む（読み込み中は何もしない） */
  ensure(dir: string): void {
    if (this.dirs.has(dir)) return;
    this.load(dir);
  }

  private load(dir: string): void {
    const g = this.gen.get(dir) ?? 0;
    this.dirs.set(dir, { kind: 'loading' });
    sharedApi.list(dir).then(
      (list) => {
        if ((this.gen.get(dir) ?? 0) !== g) return;
        const entries = new Map(list.map((e) => [e.name, e]));
        this.dirs.set(dir, { kind: 'ok', entries });
        // 一覧に現れた投稿は、もう投稿前ではない
        if (dir === ATTACHMENTS_DIR) for (const p of [...this.unposted]) if (findCaseless(entries, baseName(p))) this.unposted.delete(p);
      },
      (e: unknown) => {
        if ((this.gen.get(dir) ?? 0) !== g) return;
        const missing = e instanceof HttpError && e.code === 'not_found';
        this.dirs.set(dir, missing ? { kind: 'missing' } : { kind: 'error', message: e instanceof Error ? e.message : String(e) });
      },
    );
  }

  /** 手元の写しをすべて捨てる（接続先のサーバーが変わったとき）。読んでいる途中の結果も、世代を進めて捨てる */
  clear(): void {
    for (const dir of this.dirs.keys()) this.gen.set(dir, (this.gen.get(dir) ?? 0) + 1);
    this.dirs.clear();
  }

  /** 変わった項目（files.changed の path）に関わるフォルダの写しを捨てる。見ている側は次の描画で読み直す */
  invalidate(changed: string): void {
    for (const dir of [...this.dirs.keys()]) {
      if (!affects(dir, changed)) continue;
      this.gen.set(dir, (this.gen.get(dir) ?? 0) + 1);
      this.dirs.delete(dir);
    }
  }

  /**
   * 自分が上げた添付の、投稿前の印を付ける（on）か外す。投稿されて一覧に現れたら、自動で外れる。
   * 送ったあとに取り消して外すときは on を false にする
   */
  setUnposted(path: string, on: boolean): void {
    if (on) this.unposted.add(path.toLowerCase());
    else this.unposted.delete(path.toLowerCase());
  }

  /** 共有フォルダのパスの、今の状態。読んでいなければ loading（呼ぶ側で ensure する） */
  file(path: string): FileState {
    const st = this.dirs.get(parentOf(path));
    if (!st || st.kind === 'loading') return { kind: 'loading' };
    if (st.kind === 'missing') return { kind: 'missing' };
    if (st.kind === 'error') return { kind: 'error', message: st.message };
    const name = baseName(path);
    const entry = st.entries.get(name) ?? findCaseless(st.entries, name);
    if (entry) return { kind: 'found', entry };
    // 投稿前の自分の添付は、一覧にまだ無いのが普通（投稿の反映を待つ）
    return this.unposted.has(path.toLowerCase()) ? { kind: 'loading' } : { kind: 'missing' };
  }
}

/** 名前の大文字・小文字を区別せずに探す（添付の別名は区別しないため） */
function findCaseless(entries: Map<string, SharedEntry>, name: string): SharedEntry | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of entries) if (k.toLowerCase() === lower) return v;
  return undefined;
}

export const sharedIndex = new SharedIndex();
// 接続先が変わったら、旧サーバーの一覧を新サーバーのものとして見せない
onServerChange(() => sharedIndex.clear());
