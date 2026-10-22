import type { SharedEntry } from '../protocol/SharedEntry';
import type { SharedListing } from '../protocol/SharedListing';
import type { SharedOp } from '../protocol/SharedOp';
import { apiUrl, authHeaders } from '../config';
import { request, toError } from './http';

/**
 * 共有フォルダ（`/api/shared`）の HTTP の口。Rust の経路は無く、どの環境も fetch で呼ぶ
 * （プラグインのファイルと同じ。Tauri でも WebView から直接サーバーへ行く）。
 * パスは共有フォルダからの相対（`docs/a.txt`）。区切りごとに URL の形にする。
 */
export function sharedUrl(path: string): string {
  return apiUrl(sharedPath(path));
}

/** `/api/shared` の後ろ（パスを区切りごとに URL の形にする） */
export function sharedPath(path: string): string {
  return path === '' ? '/api/shared' : `/api/shared/${path.split('/').map((s) => encodeURIComponent(s)).join('/')}`;
}

export interface SharedApi {
  /** フォルダの中身（path が空なら直下） */
  list(path: string): Promise<SharedEntry[]>;
  /** ファイルの中身（フォルダを指すと、一覧の JSON が返る。呼ぶ側でフォルダかを確かめてから） */
  read(path: string): Promise<Blob>;
  /** 作成・上書き（親のフォルダがなければ 409 parent_missing） */
  write(path: string, body: Blob | ArrayBuffer | string): Promise<SharedEntry>;
  mkdir(path: string): Promise<SharedEntry>;
  remove(path: string): Promise<void>;
  /** 移動・名前の変更。overwrite が真なら同名のファイルを上書きする（既定は同名があれば exists） */
  move(from: string, to: string, overwrite?: boolean): Promise<SharedEntry>;
  /** コピー。overwrite の決まりは move と同じ */
  copy(from: string, to: string, overwrite?: boolean): Promise<SharedEntry>;
}

/** move / copy の本体（overwrite は helper-1 の REST 変更で入る。生成型が追いつくまで、ここで形を持つ） */
type MoveCopyOp = { op: 'move' | 'copy'; from: string; to: string; overwrite?: boolean };

export const sharedApi: SharedApi = {
  async list(path) {
    const listing = await request<SharedListing>('GET', sharedPath(path));
    return listing.entries;
  },
  async read(path) {
    const res = await fetch(sharedUrl(path), { headers: authHeaders() });
    if (!res.ok) throw await toError(res);
    return await res.blob();
  },
  async write(path, body) {
    const res = await fetch(sharedUrl(path), { method: 'PUT', headers: authHeaders(), body });
    if (!res.ok) throw await toError(res);
    return (await res.json()) as SharedEntry;
  },
  mkdir: (path) => op({ op: 'mkdir', path }),
  remove: (path) => request<void>('DELETE', sharedPath(path)),
  move: (from, to, overwrite) => op(withOverwrite({ op: 'move', from, to }, overwrite)),
  copy: (from, to, overwrite) => op(withOverwrite({ op: 'copy', from, to }, overwrite)),
};

/** overwrite は真のときだけ送る（省略は false） */
function withOverwrite(body: MoveCopyOp, overwrite: boolean | undefined): MoveCopyOp {
  return overwrite === true ? { ...body, overwrite: true } : body;
}

function op(body: SharedOp | MoveCopyOp): Promise<SharedEntry> {
  return request<SharedEntry>('POST', '/api/shared', body);
}
