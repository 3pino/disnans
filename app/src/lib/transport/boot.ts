import { devUser, getServerUrl } from '../config';
import { isDesktopStorageSupported } from '../desktopStorage';
import { getItem } from '../storage';
import { RUST_API_FLAG, selectReadApi, type ReadApiChoice, type ReadApiEnv } from './select';
import { tauriInvoke } from './tauri';

/** 起動時に実行環境から読む値（呼び出しのたびに読む。経路の決定は呼び出し側が1回だけ行う） */
export function currentBootEnv(): ReadApiEnv {
  return {
    flag: getItem(RUST_API_FLAG),
    desktop: isDesktopStorageSupported(),
    invoke: tauriInvoke,
    context: { server: () => getServerUrl(), devUser },
    log: (message) => console.info(message),
  };
}

/** api.ts の読み込み時に1回だけ呼ぶ */
export function bootReadApi(env: ReadApiEnv = currentBootEnv()): ReadApiChoice {
  return selectReadApi(env);
}
