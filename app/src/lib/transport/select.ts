import { createHttpReadApi } from './http';
import { createTauriReadApi } from './tauri';
import { createHttpWriteApi, createTauriWriteApi, type WriteApi } from './write';
import { createHttpUploadApi, createTauriUploadApi, type UploadApi } from './upload';
import type { BridgeContext, Invoke, ReadApi } from './types';
import type { BodyMode } from './body';

/**
 * 開発用の逃げ道（localStorage）。値が "0" のときだけ、読取・書込・添付を HTTP にする（Rust 経路を使わない）。
 * 未設定・"1" は、その環境に Rust 経路があれば Rust。
 */
export const RUST_API_FLAG = 'disnans.rustApi';

/** 経路を決める入力（起動の時に 1 回だけ作る） */
export type ApiEnv = {
  /** localStorage[RUST_API_FLAG] の値 */
  flag: string | null;
  /** この環境に Rust 経路があるか（Windows・Linux・Android の Tauri。それ以外の OS は HTTP のまま） */
  rustApi: boolean;
  /** 本体の渡し方（Android の WebView は base64） */
  bodyMode: BodyMode;
  invoke: Invoke;
  context: BridgeContext;
  log?: (message: string) => void;
};

/** 読取・書込・添付に Rust 経路を使うか */
export function useRustApi(env: Pick<ApiEnv, 'flag' | 'rustApi'>): boolean {
  return env.rustApi && env.flag !== '0';
}

export type ReadApiChoice = { kind: 'http' | 'tauri'; api: ReadApi };

/** 読取の経路を決める。呼び出し側はモジュールの読み込み時に1回だけ呼ぶ（boot 時固定） */
export function selectReadApi(env: ApiEnv): ReadApiChoice {
  const choice: ReadApiChoice = useRustApi(env)
    ? { kind: 'tauri', api: createTauriReadApi(env.invoke, env.context) }
    : { kind: 'http', api: createHttpReadApi() };
  env.log?.(`[disnans] api read transport: ${choice.kind}`);
  return choice;
}

export type WriteApiChoice = { kind: 'http' | 'tauri'; write: WriteApi; upload: UploadApi };

/** 書込（と添付のアップロード）の経路。読取と同じ判定。boot 時に1回だけ決める */
export function selectWriteApi(env: ApiEnv): WriteApiChoice {
  const choice: WriteApiChoice = useRustApi(env)
    ? {
        kind: 'tauri',
        write: createTauriWriteApi(env.invoke, env.context, env.bodyMode),
        upload: createTauriUploadApi(env.invoke, env.context, undefined, env.bodyMode),
      }
    : { kind: 'http', write: createHttpWriteApi(), upload: createHttpUploadApi() };
  env.log?.(`[disnans] api write transport: ${choice.kind}`);
  return choice;
}
