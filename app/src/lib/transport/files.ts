import { request } from './http';

/**
 * 投稿前のアップロードを取り消す（DELETE /api/files/{id}）。本人の、どの本文にも投稿されていない添付だけ消せる。
 * ほかの人のもの・投稿済み・attachments/ のライブラリは 403、無ければ 404（呼び出し側は失敗として黙って進める）。
 * 共有フォルダと同じく、どの環境も HTTP で呼ぶ（Rust の経路は使わない）。
 */
export function discardUpload(id: string): Promise<void> {
  return request<void>('DELETE', `/api/files/${encodeURIComponent(id)}`);
}
