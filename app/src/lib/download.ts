// 添付・共有フォルダのファイルの保存。
// - Tauri（Windows・Linux・Android）: 外部のブラウザーを経由せず、Rust（api_download）が直接保存する。終わったら
//   「ダウンロードしました: 名前」と「開く」ボタンのトーストを出す（開くのは api_download_open。保存したものだけ開く）。
// - それ以外（ブラウザーでの開発）: 従来どおり <a download>。
// 押す場所は <a href download> のままにしてある（右クリックや中クリックは、ブラウザーの既定の動きが残る）。
// 同じファイルを続けて押したときは、取得が終わるまで 2 回目を受けない。

import { devUser, getServerUrl } from './config';
import { isTauri } from './platform';
import { ui } from './stores/ui.svelte';

export type DownloadRequest = {
  /** 保存する URL（API の絶対 URL。dev_user のクエリが付くこともある） */
  url: string;
  /** 保存名の元（Rust 側で、使えない文字を直して番号を付ける） */
  name: string;
};

/** 取得してよい API のパス（Rust の is_download_path と同じ。ここで合わなければ、ブラウザーの既定に任せる） */
const DOWNLOADABLE = ['/api/files/', '/api/shared/'];

/** 取得中のパス（同じものの二重の押しを受けない） */
const inflight = new Set<string>();

/**
 * URL が、このサーバーの保存できる API のパスなら、そのパスを返す（dev_user のクエリは外す）。
 * 別のサーバー・別の経路・余分なクエリ・フラグメントは null（ブラウザーの既定に任せる）。
 */
export function downloadPath(url: string, server: string): string | null {
  let target: URL;
  let base: URL;
  try {
    target = new URL(url);
    base = new URL(server);
  } catch {
    return null;
  }
  if (target.origin !== base.origin || target.hash) return null;
  const prefix = base.pathname.replace(/\/+$/, '');
  if (!target.pathname.startsWith(`${prefix}/api/`)) return null;
  const path = target.pathname.slice(prefix.length);
  if (!DOWNLOADABLE.some((p) => path.startsWith(p))) return null;
  target.searchParams.delete('dev_user');
  if ([...target.searchParams].length > 0) return null;
  return path;
}

/** Tauri の API は、Tauri の中でだけ読む（ブラウザーの開発では読まない）。読み込みは一度だけ */
let core: Promise<typeof import('@tauri-apps/api/core')> | null = null;

async function invokeTauri<T>(command: string, args: unknown): Promise<T> {
  core ??= import('@tauri-apps/api/core');
  const { invoke } = await core;
  return invoke<T>(command, args as Record<string, unknown>);
}

/** 失敗の code を、短い日本語にする（Rust の ReadFailure。メッセージは固定の文で、パスは含まない） */
export function downloadFailureText(err: unknown): string {
  const failure = err as { code?: unknown; status?: unknown; message?: unknown } | null;
  const code = typeof failure?.code === 'string' ? failure.code : '';
  const reason = (() => {
    switch (code) {
      case 'network':
        return 'ネットワークに接続できませんでした';
      case 'timeout':
        return '応答がありませんでした';
      case 'not_found':
        return 'ファイルが見つかりません';
      case 'too_large':
        return '大きすぎるため保存しませんでした';
      case 'permission':
        return '保存先に書き込めませんでした';
      case 'no_space':
        return '保存先の空き容量が足りません';
      case 'no_dir':
        return 'ダウンロードフォルダが見つかりません';
      case 'unsupported':
        return 'この Android では保存できません（Android 10 以降が必要です）';
      case 'io':
        return '保存できませんでした';
      default:
        return typeof failure?.status === 'number' ? 'サーバーから受け取れませんでした' : '';
    }
  })();
  return reason ? `ダウンロードできませんでした: ${reason}` : 'ダウンロードできませんでした';
}

/** 開けなかったときの文 */
export function openFailureText(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'not_found') return 'ファイルが見つかりません（もう一度ダウンロードしてください）';
  return 'ファイルを開けませんでした';
}

/** ブラウザーの既定の保存（<a download>） */
function browserDownload(url: string, name: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.target = '_blank';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** 保存したものを開く（ハンドルは、この実行で保存したものだけを指す） */
export async function openDownload(handle: string): Promise<void> {
  try {
    await invokeTauri('api_download_open', { args: { handle } });
  } catch (err) {
    ui.toast(openFailureText(err), 'error');
  }
}

/**
 * ファイルを保存する。Tauri では直接保存して、トーストで知らせる。それ以外はブラウザーの既定の保存。
 * 同じパスの取得中は、2 回目を受けない。
 */
export async function downloadFile(req: DownloadRequest): Promise<void> {
  const server = getServerUrl();
  const path = isTauri() ? downloadPath(req.url, server) : null;
  if (!isTauri() || path === null) {
    browserDownload(req.url, req.name);
    return;
  }
  if (inflight.has(path)) return;
  inflight.add(path);
  try {
    const done = await invokeTauri<{ handle: string; name: string }>('api_download', {
      args: { server, devUser, path, name: req.name },
    });
    ui.toast(`ダウンロードしました: ${done.name}`, 'info', { label: '開く', run: () => void openDownload(done.handle) }, 8000);
  } catch (err) {
    ui.toast(downloadFailureText(err), 'error');
  } finally {
    inflight.delete(path);
  }
}

/**
 * <a download> の押しを受けたとき。Tauri で、このサーバーのファイルなら、ブラウザーの既定を止めて直接保存し、true を返す。
 * 左以外のボタン・修飾キー付きの押しは、そのまま（既定の動き）。
 */
export function interceptDownload(ev: MouseEvent, req: DownloadRequest): boolean {
  if (ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return false;
  if (!isTauri() || downloadPath(req.url, getServerUrl()) === null) return false;
  ev.preventDefault();
  void downloadFile(req);
  return true;
}
