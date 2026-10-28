import type { SharedEntry } from '../protocol/SharedEntry';
import type { SharedListing } from '../protocol/SharedListing';
import type { SharedOp } from '../protocol/SharedOp';
import type { SharedTrashEntry } from '../protocol/SharedTrashEntry';
import type { SharedTrashListing } from '../protocol/SharedTrashListing';
import type { SharedTrashOp } from '../protocol/SharedTrashOp';
import type { SharedSize } from '../protocol/SharedSize';
import type { ApiError } from '../protocol/ApiError';
import { apiUrl, authHeaders } from '../config';
import { HttpError, READ, request, toError } from './http';
import { sharedPath } from '../sharedPath';

/**
 * 共有フォルダ（`/api/shared`）の HTTP の口。Rust の経路は無く、どの環境も fetch で呼ぶ
 * （プラグインのファイルと同じ。Tauri でも WebView から直接サーバーへ行く）。
 * パスは共有フォルダからの相対（`docs/a.txt`）。区切りごとに URL の形にする。
 */
export function sharedUrl(path: string): string {
  return apiUrl(sharedPath(path));
}

export interface SharedApi {
  /** フォルダの中身（path が空なら直下） */
  list(path: string): Promise<SharedEntry[]>;
  /** ファイルの中身（フォルダを指すと、一覧の JSON が返る。呼ぶ側でフォルダかを確かめてから） */
  read(path: string): Promise<Blob>;
  /** 作成・上書き（親のフォルダがなければ 409 parent_missing） */
  write(path: string, body: Blob | ArrayBuffer | string): Promise<SharedEntry>;
  mkdir(path: string): Promise<SharedEntry>;
  /** 永久に削除する（既存の口。エクスプローラーはゴミ箱を使う） */
  remove(path: string): Promise<void>;
  /** ゴミ箱へ入れる（フォルダ・ファイル・添付）。入った項目を返す */
  trash(path: string): Promise<SharedTrashEntry>;
  /** ゴミ箱の一覧（新しい順はサーバーの決め。呼ぶ側で並べ替えてよい） */
  trashList(): Promise<SharedTrashEntry[]>;
  /** ゴミ箱から元の場所へ戻す。同名があれば 409 exists、親が無ければ 409 parent_missing（上書きはしない）。戻った項目を返す */
  restore(id: string): Promise<SharedEntry>;
  /** ゴミ箱の項目を完全に消す */
  purge(id: string): Promise<void>;
  /** 大きさ（size・配下のファイル数 files・フォルダ数 dirs）。path が空ならルート（添付を 1 回だけ数える） */
  size(path: string): Promise<SharedSize>;
  /** 移動・名前の変更。overwrite が真なら同名のファイルを上書きする（既定は同名があれば exists） */
  move(from: string, to: string, overwrite?: boolean): Promise<SharedEntry>;
  /** コピー。overwrite の決まりは move と同じ */
  copy(from: string, to: string, overwrite?: boolean): Promise<SharedEntry>;
}

/** move / copy の本体（overwrite は helper-1 の REST 変更で入る。生成型が追いつくまで、ここで形を持つ） */
type MoveCopyOp = { op: 'move' | 'copy'; from: string; to: string; overwrite?: boolean };

export const sharedApi: SharedApi = {
  async list(path) {
    const listing = await request<SharedListing>('GET', sharedPath(path), undefined, undefined, READ);
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
  trash: (path) => request<SharedTrashEntry>('POST', '/api/shared-trash', { op: 'trash', path } satisfies SharedTrashOp),
  trashList: async () => (await request<SharedTrashListing>('GET', '/api/shared-trash', undefined, undefined, READ)).entries,
  restore: (id) => request<SharedEntry>('POST', '/api/shared-trash', { op: 'restore', id } satisfies SharedTrashOp),
  purge: (id) => request<void>('DELETE', `/api/shared-trash/${encodeURIComponent(id)}`),
  size: (path) => request<SharedSize>('GET', sharedSizePath(path), undefined, undefined, READ),
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

/** 大きさの URL。空は `/api/shared-size`（ルート）。区切りごとに URL の形にする（sharedPath と同じ決まり） */
export function sharedSizePath(path: string): string {
  return path === '' ? '/api/shared-size' : `/api/shared-size/${path.split('/').map((s) => encodeURIComponent(s)).join('/')}`;
}

/**
 * ファイルを共有フォルダへ送る（作成・上書き）。進みを出すため XHR で送る（fetch は送信の進みが取れない）。
 * onProgress は 0〜1。中止できる（呼ぶ側へは aborted を返す）。同名は黙って上書きするので、呼ぶ前に確かめる（sharedOps.planUpload）
 */
export function uploadShared(
  path: string,
  file: Blob,
  onProgress?: (ratio: number) => void,
): { promise: Promise<SharedEntry>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<SharedEntry>((resolve, reject) => {
    xhr.open('PUT', sharedUrl(path));
    for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as SharedEntry);
        } catch {
          reject(new HttpError(xhr.status, 'bad_response', 'サーバーの応答を読めませんでした'));
        }
        return;
      }
      let code = 'http_' + xhr.status;
      let message = `HTTP ${xhr.status}`;
      try {
        const e = JSON.parse(xhr.responseText) as ApiError;
        code = e.code;
        message = e.message;
      } catch {
        // そのまま
      }
      reject(new HttpError(xhr.status, code, message));
    };
    xhr.onerror = () => reject(new HttpError(0, 'network', 'ネットワークエラー'));
    xhr.onabort = () => reject(new HttpError(0, 'aborted', '中止しました'));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}
