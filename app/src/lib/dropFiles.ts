import type { UnlistenFn } from '@tauri-apps/api/event';

/**
 * Linux で、Tauri のドロップ（ファイルのパス）を受けるための部品。
 * WebKitGTK では HTML5 のドロップで File が届かない（パスが文字として入る、画像へ移動する）ので、
 * tauri.linux.conf.json で dragDropEnabled を立て、ここでパスを受けて File にする。
 */

/** ドロップの途中経過。position は CSS ピクセル（ウィンドウの左上から） */
export type NativeDropEvent = {
  type: 'enter' | 'over' | 'drop' | 'leave';
  paths: string[];
  position: { x: number; y: number } | null;
};

/** Tauri の物理ピクセルの位置を CSS ピクセルにする */
export function toCssPoint(physical: { x: number; y: number }, dpr: number): { x: number; y: number } {
  const d = dpr > 0 ? dpr : 1;
  return { x: physical.x / d, y: physical.y / d };
}

/** 点が矩形の中にあるか（端は含まない） */
export function pointInRect(
  p: { x: number; y: number },
  r: { left: number; top: number; right: number; bottom: number },
): boolean {
  return p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < r.bottom;
}

/** パスから表示用のファイル名を取る（Windows の区切りも扱う） */
export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || 'file';
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  zip: 'application/zip',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
};

/** ファイル名の拡張子から MIME を決める（分からなければ汎用の型） */
export function mimeFromName(name: string): string {
  const m = /\.([^.]+)$/.exec(name);
  return (m && MIME_BY_EXT[m[1].toLowerCase()]) || 'application/octet-stream';
}

/**
 * ドロップの途中経過を受ける（Linux の Tauri のみ）。戻り値で止める。
 * 位置は CSS ピクセルに直して渡す。
 */
export async function listenNativeDrop(handler: (ev: NativeDropEvent) => void): Promise<UnlistenFn> {
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  return getCurrentWebview().onDragDropEvent((e) => {
    const p = e.payload;
    const position = 'position' in p ? toCssPoint(p.position, window.devicePixelRatio) : null;
    const paths = 'paths' in p ? p.paths : [];
    handler({ type: p.type, paths, position });
  });
}

/** ドロップされたパスを読んで File にする。読めなかったものは failed に名前と理由を入れる */
export async function readDroppedFiles(paths: string[]): Promise<{ files: File[]; failed: string[] }> {
  const { readFile } = await import('@tauri-apps/plugin-fs');
  const files: File[] = [];
  const failed: string[] = [];
  for (const path of paths) {
    const name = fileNameOf(path);
    try {
      const bytes = await readFile(path);
      files.push(new File([bytes], name, { type: mimeFromName(name), lastModified: Date.now() }));
    } catch (e) {
      failed.push(`${name}（${e instanceof Error ? e.message : String(e)}）`);
    }
  }
  return { files, failed };
}
