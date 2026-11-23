import { SvelteSet } from 'svelte/reactivity';
import { DirIndex, affects, type DirState } from './dirIndex.svelte';
import type { SharedEntry } from '../protocol/SharedEntry';
import { sharedApi } from '../transport/shared';
import { HttpError } from '../transport/httpError';
import { baseName, parentOf } from '../sharedPath';
import { onServerChange } from '../config';

export { affects };
export type { DirState };

/** 添付のフォルダ（`attachments/`） */
const ATTACHMENTS_DIR = 'attachments';

/** 本文のファイルリンク 1 つの状態 */
export type FileState =
  | { kind: 'loading' }
  | { kind: 'found'; entry: SharedEntry }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

/**
 * 共有フォルダの一覧の手元の写し。本文のファイルリンク（`attachments/<名前>` など）を、いま在るかと、どの項目かを引くために使う。
 * 一覧は必要になったフォルダだけ読み、files.changed で親（と中身）を読み直す（読み方・捨て方は共有の部品 DirIndex）。
 * ここで足すのは、ファイルリンクの引き方（file）と、投稿前の添付の扱い。
 */
export class SharedIndex extends DirIndex {
  /** 自分が上げて、まだ投稿されていない添付（小文字のパス）。一覧にはまだ無いので、見つからないとは出さず読み込み中にする */
  private unposted = new SvelteSet<string>();

  constructor() {
    super({
      list: (dir) => sharedApi.list(dir),
      isMissing: (e) => e instanceof HttpError && e.code === 'not_found',
    });
  }

  protected override loaded(dir: string, entries: Map<string, SharedEntry>): void {
    // 一覧に現れた投稿は、もう投稿前ではない
    if (dir === ATTACHMENTS_DIR) for (const p of [...this.unposted]) if (findCaseless(entries, baseName(p))) this.unposted.delete(p);
  }

  /**
   * 自分が上げた添付の、投稿前の印を付ける（on）か外す。投稿されて一覧に現れたら、自動で外れる。
   * 送ったあとに取り消して外すときは on を false にする
   */
  setUnposted(path: string, on: boolean): void {
    if (on) this.unposted.add(path.toLowerCase());
    else this.unposted.delete(path.toLowerCase());
  }

  /**
   * 「見つからない」と出た項目のフォルダを、読み直させる。files.changed を取りこぼして写しが古いままのとき（つなぎ直しの間・
   * デバイスが眠っていた間）の、最後の手当て。呼ぶ側が、項目ごとに 1 回だけにする（本当に無いものを読み続けない）
   */
  recheck(dir: string): void {
    this.invalidate(dir);
  }

  /** 共有フォルダのパスの、今の状態。読んでいなければ loading（呼ぶ側で ensure する） */
  file(path: string): FileState {
    const st = this.dirs.get(parentOf(path));
    if (!st || st.kind === 'loading') return { kind: 'loading' };
    if (st.kind === 'missing') return { kind: 'missing' };
    if (st.kind === 'error') return { kind: 'error', message: st.message };
    const name = baseName(path);
    // 一覧の項目は sharedApi が作った SharedEntry（共有の部品の Entry は、置き場所の持つ欄を省ける形）
    const entries = st.entries as Map<string, SharedEntry>;
    const entry = entries.get(name) ?? findCaseless(entries, name);
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
