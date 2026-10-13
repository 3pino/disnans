import { createHttpReadApi } from './http';
import { createTauriReadApi } from './tauri';
import type { BridgeContext, Invoke, ReadApi } from './types';

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

export type ReadApiChoice = { kind: 'http' | 'tauri'; api: ReadApi };

export type ReadApiEnv = {
  /** localStorage[RUST_API_FLAG] の値 */
  flag: string | null;
  /** Windows/Linux の Tauri かどうか（それ以外では Rust 経路を使わない） */
  desktop: boolean;
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
    rustEnabled(env.flag, env.desktop)
      ? { kind: 'tauri', api: createTauriReadApi(env.invoke, env.context) }
      : { kind: 'http', api: createHttpReadApi() };
  env.log?.(`[disnans] api read transport: ${choice.kind}`);
  return choice;
}

/** チャットの経路。rust は Windows/Linux の Tauri で、"disnans.rustChat" が "0" でないとき */
export function selectChatMode(env: { flag: string | null; desktop: boolean }): 'rust' | 'js' {
  return rustEnabled(env.flag, env.desktop) ? 'rust' : 'js';
}
