// 接続（サーバーに届くか）の失敗の判断と文言。起動時の取得・チャットの読み込み・接続バナーで使う。
// 届かなかった通信は、JS の fetch（ConnectionError）と、Tauri の Rust 経路（HttpError の code が timeout・network）の両方。

import { ConnectionError, HttpError } from './transport/http';

/** つながらないときに出す案内（画面の文言。利用者の確認を取る前の仮の文） */
export const CONNECTION_HINT = 'サーバーに接続できません（接続先の URL・ネットワーク・Tailscale を確認してください）';

/** 接続バナーの段階: 一瞬の切れは出さない・少し続いたら出す・長く続いたら原因と接続設定を出す */
export const BANNER_SHOW_MS = 1_500;
export const BANNER_STALL_MS = 15_000;

/** 届かなかった通信か（応答がない・つながらない） */
export function isConnectionFailure(e: unknown): boolean {
  if (e instanceof ConnectionError) return true;
  return e instanceof HttpError && (e.code === 'timeout' || e.code === 'network');
}

/** 接続が切れてからの経過（ms）から、バナーの段階を決める。切れていなければ null */
export function bannerPhase(downMs: number | null): 'hidden' | 'short' | 'stalled' {
  if (downMs === null || downMs < BANNER_SHOW_MS) return 'hidden';
  return downMs < BANNER_STALL_MS ? 'short' : 'stalled';
}

/** 失敗の原因を 1 行で（診断用）。例外の文、無ければ文字列 */
export function failureReason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
