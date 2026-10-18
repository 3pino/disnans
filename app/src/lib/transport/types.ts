import type { Message } from '../protocol/Message';
import type { PluginInfo } from '../protocol/PluginInfo';
import type { ReadMarker } from '../protocol/ReadMarker';
import type { Session } from '../protocol/Session';
import type { User } from '../protocol/User';

/**
 * 読取 REST の経路（ステップ4 段1）。`api` の読取メソッドと同じ引数・戻り値。
 * 実装は HTTP（従来の fetch）と Tauri（Rust 経由）の2つ。どちらを使うかは起動時に1回だけ決める。
 */
export interface ReadApi {
  me(): Promise<User>;
  users(): Promise<User[]>;
  prefs(): Promise<Record<string, unknown>>;
  messages(opts: { before?: string | null; limit?: number }): Promise<Message[]>;
  searchMessages(opts: { q: string; before?: string | null; limit?: number }): Promise<Message[]>;
  readMarkers(): Promise<ReadMarker[]>;
  plugins(): Promise<PluginInfo[]>;
  session(id: string): Promise<Session>;
}

/** Tauri コマンドが reject する値（契約: .pi/step4-ipc-contract.md §5） */
export type ApiBridgeError = { status?: number; code: string; message: string };

/** IPC のヘッダー（raw body の付随情報。値は encodeURIComponent 済みの文字列にする） */
export type InvokeOptions = { headers?: Record<string, string> };

/**
 * Tauri の `invoke` と同じ形（テストで差し替える）。
 * args が Uint8Array のときは raw body として送る（添付・アバターのバイト列）。その場合の付随情報は options.headers。
 */
export type Invoke = <T>(command: string, args?: Record<string, unknown> | Uint8Array | string, options?: InvokeOptions) => Promise<T>;

/** 呼び出しごとに評価する接続情報（server は applyServerUrl 後の値、devUser は起動時に決まる値） */
export type BridgeContext = { server: () => string; devUser: string | null };
