import { devUser, getServerUrl, isAndroid, isTauri } from '../config';
import { isDesktopStorageSupported } from '../desktopStorage';
import { getItem } from '../storage';
import { CHAT_RUST_FLAG, RUST_API_FLAG, selectChatMode, selectReadApi, type ReadApiChoice, type ReadApiEnv } from './select';
import type { ChatTransport } from './chat';
import { createTauriChatTransport } from './tauriChat';
import { selectWriteApi, type WriteApiChoice } from './select';
import { tauriInvoke } from './tauri';
import type { BridgeContext } from './types';

const bridgeContext = (): BridgeContext => ({ server: () => getServerUrl(), devUser });

/** 起動時に実行環境から読む値（呼び出しのたびに読む。経路の決定は呼び出し側が1回だけ行う） */
export function currentBootEnv(): ReadApiEnv {
  return {
    flag: getItem(RUST_API_FLAG),
    desktop: isDesktopStorageSupported(),
    android: isTauri() && isAndroid(),
    invoke: tauriInvoke,
    context: bridgeContext(),
    log: (message) => console.info(message),
  };
}

/** api.ts の読み込み時に1回だけ呼ぶ */
export function bootReadApi(env: ReadApiEnv = currentBootEnv()): ReadApiChoice {
  return selectReadApi(env);
}

/** api.ts の読み込み時に1回だけ呼ぶ（書込と添付） */
export function bootWriteApi(env: ReadApiEnv = currentBootEnv()): WriteApiChoice {
  return selectWriteApi(env);
}

/** チャットの経路を決める（rust のとき Tauri 実装、js のとき null）。client.start() で1回だけ呼ぶ */
export function bootChatTransport(
  env: { flag: string | null; desktop: boolean; invoke: typeof tauriInvoke; context: BridgeContext; log?: (m: string) => void } = {
    flag: getItem(CHAT_RUST_FLAG),
    desktop: isDesktopStorageSupported(),
    invoke: tauriInvoke,
    context: bridgeContext(),
    log: (message) => console.info(message),
  },
): ChatTransport | null {
  const mode = selectChatMode(env);
  env.log?.(`[disnans] chat transport: ${mode}`);
  return mode === 'rust' ? createTauriChatTransport(env.invoke, env.context) : null;
}
