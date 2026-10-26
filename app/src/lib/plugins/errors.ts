import { ConnectionError, HttpError } from '../transport/http';
import { errorMessage } from './types';

/**
 * プラグインに渡す例外（disnans.PluginError）。`code` は機械向けの語で、表示用の文は message。
 *
 * code の決まり:
 * - サーバーのエラー（HTTP の失敗）は、サーバーの code をそのまま使う（例: `not_found`、`version_conflict`）
 * - 本体側の失敗は次の語を使う:
 *   - `disconnected`: サーバーに届かなかった（通信の失敗）
 *   - `not_loaded`: プラグインが本体に読み込まれていない
 *   - `invalid_argument`: 渡された値が正しくない（例: messages と messageIds の両方）
 *   - `not_found`: 本体の中に、指定されたもの（view の種類など）がない
 *   - `stopped`: プラグインが外された、またはセッションがもう使えない
 *   - `unsupported`: この環境では使えない（例: 画面を撮る機能が無い環境）
 *   - `permission_denied`: manifest.json の permissions に無い権限の API を呼んだ（例: 共有フォルダは "files"）
 *   - `failed`: 上のどれでもない、本体側の失敗
 */
export const LOCAL_ERROR_CODES = [
  'disconnected',
  'not_loaded',
  'invalid_argument',
  'not_found',
  'stopped',
  'unsupported',
  'permission_denied',
  'failed',
] as const;

export type LocalErrorCode = (typeof LOCAL_ERROR_CODES)[number];

/** 他の人の更新とぶつかった（Session.update。サーバーの code と同じ） */
export const VERSION_CONFLICT = 'version_conflict';

/** disnans.PluginError の実体。`instanceof` と `code` で見分ける */
export class PluginError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'PluginError';
    this.code = code;
  }
}

/** Session.update が他の人の更新とぶつかったときのエラー（disnans.VersionConflictError。PluginError の一種） */
export class VersionConflictError extends PluginError {
  constructor(message = 'ほかの人の更新とぶつかりました') {
    super(VERSION_CONFLICT, message);
    this.name = 'VersionConflictError';
  }
}

/**
 * 例外を PluginError にそろえる。
 * サーバーの HTTP エラーは code をそのまま渡し、届かなかった通信（fetch の失敗）は disconnected、
 * それ以外は fallback の code にする。すでに PluginError ならそのまま返す。
 */
export function toPluginError(e: unknown, fallback: LocalErrorCode = 'failed'): PluginError {
  if (e instanceof PluginError) return e;
  if (e instanceof VersionConflictError) return e;
  if (e instanceof HttpError) {
    if (e.code === VERSION_CONFLICT) return new VersionConflictError(e.message);
    return new PluginError(e.code, e.message);
  }
  // 届かなかった通信（応答がない・fetch の失敗）は disconnected
  if (e instanceof ConnectionError || e instanceof TypeError) return new PluginError('disconnected', errorMessage(e));
  return new PluginError(fallback, errorMessage(e));
}

/** 関数の失敗を PluginError にそろえる（サーバーを呼ぶ本体の API に使う） */
export function plainPluginErrors<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return (...args: A) => fn(...args).catch((e: unknown) => {
    throw toPluginError(e);
  });
}
