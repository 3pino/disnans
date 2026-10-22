import type { SharedEntry } from '../protocol/SharedEntry';
import type { SharedApi } from '../transport/shared';
import { PluginError, toPluginError } from './errors';

/** manifest.json の permissions に入れると使える、共有フォルダの権限（disnans.Plugin の files） */
export const PERMISSION_FILES = 'files';

/** 共有フォルダの変更（`files.changed`）を受け取る口。解除関数を返す */
export type FilesChangedSubscribe = (cb: (path: string) => void) => () => void;

/** move / copy の任意の指定 */
export type FileCopyOptions = { overwrite?: boolean };

/** 権限があるか（manifest.json の permissions に "files" があるか） */
export function hasPermission(permissions: readonly string[] | undefined, name: string): boolean {
  return !!permissions?.includes(name);
}

/** 権限のないプラグインが呼んだときの例外 */
function denied(): PluginError {
  return new PluginError('permission_denied', `この操作には権限（"${PERMISSION_FILES}"）が必要です。manifest.json の permissions に入れてください`);
}

/**
 * パスの決まり（サーバーの検査の手前で、明らかに正しくないものを invalid_argument にする）。
 * 区切りは `/`。空の区切り・`.`・`..` は使えない。空文字（直下）は allowRoot のときだけ。
 */
export function checkSharedPath(path: unknown, allowRoot = false): string {
  if (typeof path !== 'string') throw new PluginError('invalid_argument', 'パスは文字列にしてください');
  if (path === '') {
    if (allowRoot) return path;
    throw new PluginError('invalid_argument', 'パスが空です');
  }
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') throw new PluginError('invalid_argument', `パス「${path}」が正しくありません`);
  }
  return path;
}

/** 親のフォルダのパス（直下なら空文字） */
export function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/**
 * プラグインに渡す共有フォルダの API（disnans.Plugin の files）。
 * 権限がなければ、どの操作も PluginError（permission_denied）で失敗する。
 * サーバーの失敗（not_found・forbidden・exists・parent_missing・too_large・insufficient_storage）は、その code のまま。
 */
export class PluginFiles {
  constructor(
    private readonly allowed: boolean,
    private readonly api: SharedApi,
    private readonly subscribe: FilesChangedSubscribe,
  ) {}

  private need(): void {
    if (!this.allowed) throw denied();
  }

  /** サーバーの失敗を PluginError にそろえる */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw toPluginError(e);
    }
  }

  /** フォルダの中身（path が空なら直下） */
  async list(path = ''): Promise<SharedEntry[]> {
    this.need();
    const p = checkSharedPath(path, true);
    return this.call(() => this.api.list(p));
  }

  /** 1 つの項目の情報（親のフォルダの一覧から探す）。なければ not_found */
  async stat(path: string): Promise<SharedEntry> {
    this.need();
    const p = checkSharedPath(path);
    return this.call(async () => {
      const entries = await this.api.list(parentOf(p));
      const found = entries.find((e) => e.path === p);
      if (!found) throw new PluginError('not_found', `「${p}」はありません`);
      return found;
    });
  }

  /** ファイルの中身（Blob。文字は `await (await files.read(p)).text()`）。フォルダは invalid_argument */
  async read(path: string): Promise<Blob> {
    this.need();
    const p = checkSharedPath(path);
    const entry = await this.stat(p);
    if (entry.kind === 'dir') throw new PluginError('invalid_argument', `「${p}」はフォルダです`);
    return this.call(() => this.api.read(p));
  }

  /** 作成・上書き。data は Blob・ArrayBuffer・文字列 */
  async write(path: string, data: Blob | ArrayBuffer | string): Promise<SharedEntry> {
    this.need();
    const p = checkSharedPath(path);
    if (!(data instanceof Blob) && !(data instanceof ArrayBuffer) && typeof data !== 'string') {
      throw new PluginError('invalid_argument', 'data は Blob・ArrayBuffer・文字列のどれかにしてください');
    }
    return this.call(() => this.api.write(p, data));
  }

  /** フォルダを作る */
  async mkdir(path: string): Promise<SharedEntry> {
    this.need();
    const p = checkSharedPath(path);
    return this.call(() => this.api.mkdir(p));
  }

  /** 削除（フォルダは中身ごと） */
  async remove(path: string): Promise<void> {
    this.need();
    const p = checkSharedPath(path);
    return this.call(() => this.api.remove(p));
  }

  /** 移動・名前の変更。opts.overwrite が真なら同名を上書きする（既定は同名があれば exists） */
  async move(from: string, to: string, opts: FileCopyOptions = {}): Promise<SharedEntry> {
    this.need();
    const f = checkSharedPath(from);
    const t = checkSharedPath(to);
    return this.call(() => this.api.move(f, t, opts.overwrite === true));
  }

  /** コピー。opts.overwrite の決まりは move と同じ */
  async copy(from: string, to: string, opts: FileCopyOptions = {}): Promise<SharedEntry> {
    this.need();
    const f = checkSharedPath(from);
    const t = checkSharedPath(to);
    return this.call(() => this.api.copy(f, t, opts.overwrite === true));
  }

  /** 共有フォルダの変更（作成・上書き・移動・コピー・削除。どの端末でも）。cb は `{ path }`。解除関数を返す */
  onChange(cb: (ev: { path: string }) => void): () => void {
    this.need();
    if (typeof cb !== 'function') throw new PluginError('invalid_argument', 'cb は関数にしてください');
    return this.subscribe((path) => cb({ path }));
  }
}
