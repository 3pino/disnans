import { devUser, getServerUrl } from '../config';
import { capabilities } from '../platform';
import { getItem } from '../storage';
import { RUST_API_FLAG, selectReadApi, selectWriteApi, type ApiEnv, type ReadApiChoice, type WriteApiChoice } from './select';
import type { ChatTransport } from './chat';
import { createTauriChatTransport } from './tauriChat';
import { tauriInvoke } from './tauri';
import type { BridgeContext } from './types';

const bridgeContext = (): BridgeContext => ({ server: () => getServerUrl(), devUser });

/** 起動時に実行環境から読む値（呼び出しのたびに読む。経路の決定は呼び出し側が1回だけ行う）。方針は capabilities() から */
export function currentBootEnv(): ApiEnv {
  const caps = capabilities();
  return {
    flag: getItem(RUST_API_FLAG),
    rustApi: caps.rustApi,
    bodyMode: caps.bodyMode,
    invoke: tauriInvoke,
    context: bridgeContext(),
    log: (message) => console.info(message),
  };
}

/** api.ts の読み込み時に1回だけ呼ぶ */
export function bootReadApi(env: ApiEnv = currentBootEnv()): ReadApiChoice {
  return selectReadApi(env);
}

/** api.ts の読み込み時に1回だけ呼ぶ（書込と添付） */
export function bootWriteApi(env: ApiEnv = currentBootEnv()): WriteApiChoice {
  return selectWriteApi(env);
}

/** チャットの起動の入力。enabled は Rust 経路を持つ環境か（方針の rustApi） */
export type ChatBootEnv = {
  enabled: boolean;
  invoke: typeof tauriInvoke;
  context: BridgeContext;
  log?: (message: string) => void;
};

export function currentChatBootEnv(): ChatBootEnv {
  return {
    enabled: capabilities().rustApi,
    invoke: tauriInvoke,
    context: bridgeContext(),
    log: (message) => console.info(message),
  };
}

/**
 * チャットの経路（契約 §8.1）。Rust 経路を持つ環境（Windows・Linux・Android の Tauri）だけ Rust のチャットを使う。
 * それ以外（対象外の OS）はチャットなし（null）。JS の WebSocket は使わない。client.start() で1回だけ呼ぶ。
 */
export function bootChatTransport(env: ChatBootEnv = currentChatBootEnv()): ChatTransport | null {
  if (!env.enabled) {
    env.log?.('[disnans] chat transport: none');
    return null;
  }
  env.log?.('[disnans] chat transport: rust');
  return createTauriChatTransport(env.invoke, env.context);
}
