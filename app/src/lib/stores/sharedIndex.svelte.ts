import { SvelteMap } from 'svelte/reactivity';
import type { SharedEntry } from '../protocol/SharedEntry';
import { sharedApi } from '../transport/shared';
import { HttpError } from '../transport/http';
import { baseName, parentOf } from '../sharedPath';

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
        this.dirs.set(dir, { kind: 'ok', entries: new Map(list.map((e) => [e.name, e])) });
      },
      (e: unknown) => {
        if ((this.gen.get(dir) ?? 0) !== g) return;
        const missing = e instanceof HttpError && e.code === 'not_found';
        this.dirs.set(dir, missing ? { kind: 'missing' } : { kind: 'error', message: e instanceof Error ? e.message : String(e) });
      },
    );
  }

  /** 変わった項目（files.changed の path）に関わるフォルダの写しを捨てる。見ている側は次の描画で読み直す */
  invalidate(changed: string): void {
    for (const dir of [...this.dirs.keys()]) {
      if (!affects(dir, changed)) continue;
      this.gen.set(dir, (this.gen.get(dir) ?? 0) + 1);
      this.dirs.delete(dir);
    }
  }

  /** 共有フォルダのパスの、今の状態。読んでいなければ loading（呼ぶ側で ensure する） */
  file(path: string): FileState {
    const st = this.dirs.get(parentOf(path));
    if (!st || st.kind === 'loading') return { kind: 'loading' };
    if (st.kind === 'missing') return { kind: 'missing' };
    if (st.kind === 'error') return { kind: 'error', message: st.message };
    const name = baseName(path);
    const entry = st.entries.get(name) ?? findCaseless(st.entries, name);
    return entry ? { kind: 'found', entry } : { kind: 'missing' };
  }
}

/** 名前の大文字・小文字を区別せずに探す（添付の別名は区別しないため） */
function findCaseless(entries: Map<string, SharedEntry>, name: string): SharedEntry | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of entries) if (k.toLowerCase() === lower) return v;
  return undefined;
}

export const sharedIndex = new SharedIndex();
