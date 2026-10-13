import { createHttpReadApi } from './http';
import { createTauriReadApi } from './tauri';
import type { BridgeContext, Invoke, ReadApi } from './types';

/** 読取の Rust 経路を有効にする localStorage キー（値は "1" のときだけ有効。既定 off） */
export const RUST_API_FLAG = 'disnans.rustApi';

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
 * フラグが "1" でも、デスクトップ以外・フラグ off のときは HTTP のまま。
 */
export function selectReadApi(env: ReadApiEnv): ReadApiChoice {
  const choice: ReadApiChoice =
    env.flag === '1' && env.desktop
      ? { kind: 'tauri', api: createTauriReadApi(env.invoke, env.context) }
      : { kind: 'http', api: createHttpReadApi() };
  env.log?.(`[disnans] api read transport: ${choice.kind}`);
  return choice;
}
