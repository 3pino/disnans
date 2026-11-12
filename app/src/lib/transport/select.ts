import { createTauriReadApi } from './tauri';
import { createTauriWriteApi, type WriteApi } from './write';
import { createTauriUploadApi, type UploadApi } from './upload';
import type { BridgeContext, Invoke, ReadApi } from './types';
import type { BodyMode } from './body';

/** 経路を作る入力（起動の時に 1 回だけ作る） */
export type ApiEnv = {
  /** 本体の渡し方（Android の WebView は base64） */
  bodyMode: BodyMode;
  invoke: Invoke;
  context: BridgeContext;
};

/** 読取の経路。Rust（Tauri）だけ。呼び出し側はモジュールの読み込み時に1回だけ呼ぶ */
export function selectReadApi(env: ApiEnv): ReadApi {
  return createTauriReadApi(env.invoke, env.context);
}

export type WriteApiChoice = { write: WriteApi; upload: UploadApi };

/** 書込（と添付のアップロード）の経路。boot 時に1回だけ決める */
export function selectWriteApi(env: ApiEnv): WriteApiChoice {
  return {
    write: createTauriWriteApi(env.invoke, env.context, env.bodyMode),
    upload: createTauriUploadApi(env.invoke, env.context, undefined, env.bodyMode),
  };
}
