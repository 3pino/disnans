import { createHttpReadApi } from './http';
import { createTauriReadApi } from './tauri';
import { createHttpWriteApi, createTauriWriteApi, type WriteApi } from './write';
import { createHttpUploadApi, createTauriUploadApi, type UploadApi } from './upload';
import type { BridgeContext, Invoke, ReadApi } from './types';
import type { BodyMode } from './body';

/**
 * 読取の Rust 経路の切り替え（localStorage キー）。Windows/Linux の Tauri では既定で on。
 * 値が "0" のときだけ off（従来の TS 経路に戻す逃げ道）。未設定・"1" は on。
 */
export const RUST_API_FLAG = 'disnans.rustApi';

/** チャットの Rust 経路の切り替え（localStorage キー）。読取とは独立。既定の扱いは RUST_API_FLAG と同じ */
export const CHAT_RUST_FLAG = 'disnans.rustChat';

/** Rust 経路を使うか。デスクトップ（Windows/Linux の Tauri）で、フラグが "0" でないとき */
export function rustEnabled(flag: string | null, desktop: boolean): boolean {
  return desktop && flag !== '0';
}

/**
 * 読取・書込・添付の Rust 経路。デスクトップ（Windows/Linux）と Android の Tauri で、フラグが "0" でないとき。
 * チャットは含まない（chat_* は Android に未登録。rustEnabled のまま）。
 */
export function rustApiEnabled(flag: string | null, env: { desktop: boolean; android?: boolean; rustApi?: boolean }): boolean {
  const allowed = env.rustApi ?? (env.desktop || !!env.android);
  return allowed && flag !== '0';
}

export type ReadApiChoice = { kind: 'http' | 'tauri'; api: ReadApi };

export type ReadApiEnv = {
  /** localStorage[RUST_API_FLAG] の値 */
  flag: string | null;
  /** Windows/Linux の Tauri かどうか（それ以外では Rust 経路を使わない。チャットもこれで決まる） */
  desktop: boolean;
  /** Android の Tauri かどうか（読取・書込・添付だけ Rust。本体は base64 で渡す） */
  android?: boolean;
  /** 方針の値（capabilities.rustApi）。無いときは desktop と android から決める */
  rustApi?: boolean;
  /** 本体の渡し方（capabilities.bodyMode）。無いときは android から決める */
  bodyMode?: BodyMode;
  invoke: Invoke;
  context: BridgeContext;
  log?: (message: string) => void;
};

/**
 * 読取の経路を決める。呼び出し側はモジュールの読み込み時に1回だけ呼ぶ（boot 時固定）。
 * デスクトップ以外（ブラウザ・Android・macOS）と、フラグ "0" のときは HTTP のまま。
 */
export function selectReadApi(env: ReadApiEnv): ReadApiChoice {
  const choice: ReadApiChoice =
    rustApiEnabled(env.flag, env)
      ? { kind: 'tauri', api: createTauriReadApi(env.invoke, env.context) }
      : { kind: 'http', api: createHttpReadApi() };
  env.log?.(`[disnans] api read transport: ${choice.kind}`);
  return choice;
}

export type WriteApiChoice = { kind: 'http' | 'tauri'; write: WriteApi; upload: UploadApi };

/**
 * 書込（と添付のアップロード）の経路。読取と同じ判定（rustEnabled）。boot 時に1回だけ決める。
 * 読取と書込は別々に決めるが、同じ localStorage の値と同じ実行環境から決まるので常に揃う。
 */
export function selectWriteApi(env: ReadApiEnv): WriteApiChoice {
  const mode: BodyMode = env.bodyMode ?? (env.android ? 'base64' : 'raw');
  const choice: WriteApiChoice = rustApiEnabled(env.flag, env)
    ? { kind: 'tauri', write: createTauriWriteApi(env.invoke, env.context, mode), upload: createTauriUploadApi(env.invoke, env.context, undefined, mode) }
    : { kind: 'http', write: createHttpWriteApi(), upload: createHttpUploadApi() };
  env.log?.(`[disnans] api write transport: ${choice.kind}`);
  return choice;
}

/**
 * チャットの経路（契約 §8.1）。
 * - デスクトップ（Windows/Linux の Tauri）: "disnans.rustChat" が "0" でなければ rust（既定 on）。
 * - Android の Tauri: opt-in のみ。"disnans.rustChat" が "1" のときだけ rust（既定 off。背景中の切断を実機で切り分けるまで）。
 * - それ以外（ブラウザ・macOS など）は js。
 */
export function selectChatMode(env: { flag: string | null; desktop: boolean; android?: boolean; rustChat?: 'default' | 'opt-in' | 'off' }): 'rust' | 'js' {
  // 方針の値（capabilities.rustChat）があれば、それに従う
  if (env.rustChat !== undefined) {
    if (env.rustChat === 'default') return env.flag !== '0' ? 'rust' : 'js';
    if (env.rustChat === 'opt-in') return env.flag === '1' ? 'rust' : 'js';
    return 'js';
  }
  if (env.desktop) return rustEnabled(env.flag, true) ? 'rust' : 'js';
  if (env.android) return env.flag === '1' ? 'rust' : 'js';
  return 'js';
}
