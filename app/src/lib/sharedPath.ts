// 共有フォルダのパスの小さな決まり（URL・親のフォルダ・名前）。サーバーと同じ区切り `/`。

/** 親のフォルダ（直下の項目は空文字） */
export function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** 名前（最後の区切りの後ろ） */
export function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

/** `/api/shared` の後ろ（パスを区切りごとに URL の形にする）。空は共有フォルダの直下 */
export function sharedPath(path: string): string {
  return path === '' ? '/api/shared' : `/api/shared/${path.split('/').map((s) => encodeURIComponent(s)).join('/')}`;
}
