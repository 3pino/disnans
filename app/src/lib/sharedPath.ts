// 共有フォルダのパスの小さな決まり（URL・親のフォルダ・名前）。サーバーと同じ区切り `/`。
// 親・名前は共有の部品（@3pino/explorer-kit の path）と同じもの。

export { parentOf, baseName } from '@3pino/explorer-kit';

/** `/api/shared` の後ろ（パスを区切りごとに URL の形にする）。空は共有フォルダの直下 */
export function sharedPath(path: string): string {
  return path === '' ? '/api/shared' : `/api/shared/${path.split('/').map((s) => encodeURIComponent(s)).join('/')}`;
}
