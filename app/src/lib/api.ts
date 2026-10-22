import type { CreateSession } from './protocol/CreateSession';
import type { MarkRead } from './protocol/MarkRead';
import type { PluginInfo } from './protocol/PluginInfo';
import type { PluginVisibility } from './protocol/PluginVisibility';
import type { PluginNotify } from './protocol/PluginNotify';
import type { PluginPostMessage } from './protocol/PluginPostMessage';
import type { UpdateMe } from './protocol/UpdateMe';
import type { UpdateSession } from './protocol/UpdateSession';
import type { User } from './protocol/User';
import { apiUrl, authHeaders } from './config';
import { qs, request, toError } from './transport/http';
import { bootReadApi, bootWriteApi } from './transport/boot';
import type { UploadHandle } from './transport/upload';
import { sharedApi } from './transport/shared';

export { HttpError } from './transport/http';
export type { UploadHandle } from './transport/upload';

/** 読取の経路（Windows/Linux の Tauri では Rust。localStorage "disnans.rustApi"="0" で従来の HTTP）。読み込み時に1回だけ決める */
const reads = bootReadApi().api;
/** 書込と添付の経路（読取と同じ判定。読み込み時に1回だけ決める） */
const writes = bootWriteApi();

export const api = {
  me: () => reads.me(),
  /** 初回設定で、保存前のサーバー URL に接続できるか確かめる */
  probe: (base: string) => request<User>('GET', '/api/me', undefined, base),
  updateMe: (body: UpdateMe) => writes.write.updateMe(body),
  /** 自分のアバターを設定する（サーバーで中央を正方形に切り抜き、256px の WebP にする） */
  setAvatar: (file: Blob, fileName = 'avatar'): Promise<User> => writes.write.setAvatar(file, fileName),
  /** 自分で設定したアバターを消し、Tailscale のプロフィール画像に戻す */
  clearAvatar: () => writes.write.clearAvatar(),
  /** 自分の設定（デバイスをまたいで共有する。中身はクライアントが決める JSON オブジェクト） */
  prefs: () => reads.prefs(),
  setPrefs: (prefs: Record<string, unknown>) => writes.write.setPrefs(prefs),
  users: () => reads.users(),
  messages: (opts: { before?: string | null; limit?: number }) => reads.messages(opts),
  /** 本文の全文検索（新しい順。空白で区切った語をすべて含むもの） */
  searchMessages: (opts: { q: string; before?: string | null; limit?: number }) => reads.searchMessages(opts),
  /** 自分にサンプルの通知を送る */
  sampleNotification: () => writes.write.sampleNotification(),
  /** 既読の位置と未読数（メインチャット） */
  readMarkers: () => reads.readMarkers(),
  /** 既読の位置を進める（戻らない） */
  markRead: (body: MarkRead) => writes.write.markRead(body),

  // ---- プラグイン ----
  plugins: () => reads.plugins(),
  /** 配布・更新。files は manifest.json / main.js / styles.css / theme.css / icon.svg（ファイル名で見分ける） */
  publishPlugin: (files: { name: string; data: Blob }[], visibility: PluginVisibility = 'public'): Promise<PluginInfo> =>
    writes.write.publishPlugin(files, visibility),
  deletePlugin: (id: string) => writes.write.deletePlugin(id),
  /** 配布されたファイルの中身（hash を付けてキャッシュを区別する） */
  pluginFile: async (id: string, name: string, hash: string): Promise<string> => {
    const res = await fetch(apiUrl(`/api/plugins/${encodeURIComponent(id)}/files/${encodeURIComponent(name)}${qs({ v: hash })}`), {
      headers: authHeaders(),
    });
    if (!res.ok) throw await toError(res);
    return await res.text();
  },
  pluginPostMessage: (id: string, body: PluginPostMessage) => writes.write.pluginPostMessage(id, body),
  pluginNotify: (id: string, body: PluginNotify) => writes.write.pluginNotify(id, body),

  // ---- 共有フォルダ（/api/shared。HTTP のみ。プラグインの files も同じ） ----
  shared: sharedApi,

  // ---- セッション ----
  createSession: (body: CreateSession) => writes.write.createSession(body),
  session: (id: string) => reads.session(id),
  /** version が合わなければ 409 version_conflict */
  updateSession: (id: string, body: UpdateSession) => writes.write.updateSession(id, body),
};

/** 進捗を取ってアップロードする（Windows/Linux の Tauri では Rust 経由。中止・再送の扱いは transport/upload.ts） */
export function uploadFile(file: File, onProgress?: (ratio: number) => void): UploadHandle {
  return writes.upload.upload(file, onProgress);
}
