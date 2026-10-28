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

// ---- OS からのフォルダ・ファイルのドロップ（エクスプローラーのコピー用の入力）----
// Linux（ネイティブのドロップ）: Rust が根を覚え、JS は根の中だけを列挙・読む（os_drop.rs）。
// Windows（HTML5 のドロップ）: webkitGetAsEntry でフォルダの中まで走査する（ブラウザーの API）。
// どちらも同じ形で返す: rel は最初の名前から始まり `/` で区切る。空のフォルダも入る。読むのは read() を呼んだときだけ。

/** OS からドロップされた 1 つの項目（フォルダは中身も含めて平らに並ぶ。親が先） */
export type OsDropEntry =
  | { rel: string; dir: true }
  | { rel: string; dir: false; size: number; read: () => Promise<Blob> };

/** Rust の `os-drop` のペイロード（位置は物理ピクセル）。id と error はどちらか一方が入る */
export type OsDropWire = {
  id: number | null;
  error: string | null;
  roots: { name: string; dir: boolean }[];
  /** 根にできなかったもの（シンボリックリンクなど） */
  skipped: string[];
  position: { x: number; y: number } | null;
};

/** listenOsDrop が渡すもの（位置は CSS ピクセル。ドロップしたウィンドウだけに届く） */
export type OsDropEvent = Omit<OsDropWire, 'position'> & { position: { x: number; y: number } | null };

export const OS_DROP_EVENT = 'os-drop';

type Call = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

async function defaultCall<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

/** 名前の連結（`/` 区切り） */
export function joinRel(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`;
}

/**
 * Linux: ネイティブのドロップを知らせる（ドロップのたびに届く。どの画面へ送るかは呼ぶ側が決める）。
 * 位置は物理ピクセルから CSS ピクセルに直して渡す（同じペイロードの中で。別のイベントとの順序に頼らない）。
 */
export async function listenOsDrop(handler: (ev: OsDropEvent) => void): Promise<UnlistenFn> {
  const { listen } = await import('@tauri-apps/api/event');
  return listen<OsDropWire>(OS_DROP_EVENT, (e) => {
    const p = e.payload;
    handler({
      ...p,
      position: p.position ? toCssPoint(p.position, globalThis.devicePixelRatio) : null,
    });
  });
}

/** Linux: 使い終わったドロップを外す（覚えた根を Rust から消す）。二度呼んでも害はない */
export async function osDropRelease(id: number, call: Call = defaultCall): Promise<void> {
  await call<void>('os_drop_release', { id });
}

/** Linux: 根（id のドロップ）の中身を全部列挙する。読むのはまだ（read は 1 つずつ呼ぶ） */
export async function osDropEntries(
  id: number,
  call: Call = defaultCall,
): Promise<{ entries: OsDropEntry[]; skipped: string[] }> {
  const listing = await call<{ entries: { rel: string; dir: boolean; size: number }[]; skipped: string[] }>(
    'os_drop_list',
    { id },
  );
  const entries: OsDropEntry[] = listing.entries.map((e) =>
    e.dir
      ? { rel: e.rel, dir: true }
      : { rel: e.rel, dir: false, size: e.size, read: () => readOsDropFile(id, e.rel, call) },
  );
  return { entries, skipped: listing.skipped };
}

/** Linux: 根の中の 1 つのファイルを読む（Rust から、バイナリのまま）。読めなければ例外 */
export async function readOsDropFile(id: number, rel: string, call: Call = defaultCall): Promise<Blob> {
  const bytes = await call<ArrayBuffer>('os_drop_read', { id, rel });
  return new Blob([bytes], { type: mimeFromName(fileNameOf(rel)) });
}

/**
 * Windows（HTML5 のドロップ）: ドロップの中で、DataTransfer の項目の入口（FileSystemEntry）を取る。
 * この関数は必ずドロップのイベントの中で呼ぶ（後からは取れない）。ファイル・フォルダの両方を返す。
 */
export function dropRootsOf(dt: DataTransfer | null | undefined): FileSystemEntry[] {
  if (!dt) return [];
  const roots: FileSystemEntry[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry();
    if (entry) roots.push(entry);
  }
  return roots;
}

/** Rust の os_drop_walk と同じ上限（読んだ項目の数・フォルダの深さ）。超えたら止める（集めきってから数えない） */
export const OS_DROP_LIMITS = { maxEntries: 50_000, maxDepth: 32 } as const;

type Budget = { visited: number; maxEntries: number; maxDepth: number };

/** Windows: 取った入口から、フォルダの中まで平らにする（親が先）。読むのは後から。上限を超えたら例外 */
export async function entriesFromDropRoots(
  roots: FileSystemEntry[],
  limits: { maxEntries: number; maxDepth: number } = OS_DROP_LIMITS,
): Promise<OsDropEntry[]> {
  const out: OsDropEntry[] = [];
  const budget: Budget = { visited: 0, ...limits };
  // 同じ名前の根は、黙って上書きしないよう別の名前にする（Rust の根と同じ決まり）
  const names = uniqueRootNames(roots.map((r) => ({ name: r.name, dir: r.isDirectory })));
  for (let i = 0; i < roots.length; i++) await walkFsEntry(roots[i]!, names[i]!, out, 1, budget);
  return out;
}

/**
 * 同じ名前の根に別の名前を付ける（Rust の os_drop_walk と同じ決まり）。
 * ファイルは拡張子の前に「 (n)」（photo.jpg → photo (2).jpg）、フォルダは後ろに（docs → docs (2)）。
 * 先頭だけの点（.rc）や末尾の点（trailing.）は拡張子とみなさない。先に来たものが元の名前を取る。
 */
export function withSuffix(base: string, n: number, dir: boolean): string {
  if (!dir) {
    const dot = base.lastIndexOf('.');
    if (dot > 0 && dot + 1 < base.length) return `${base.slice(0, dot)} (${n}).${base.slice(dot + 1)}`;
  }
  return `${base} (${n})`;
}

export function uniqueRootNames(roots: readonly { name: string; dir: boolean }[]): string[] {
  const used = new Set<string>();
  return roots.map((r) => {
    let name = r.name;
    for (let n = 2; used.has(name); n++) name = withSuffix(r.name, n, r.dir);
    used.add(name);
    return name;
  });
}

/** 1 つ読んだら数える（超えたら、それ以上は読まない） */
function visit(b: Budget): void {
  b.visited += 1;
  if (b.visited > b.maxEntries) throw new Error('項目が多すぎます');
}

async function walkFsEntry(entry: FileSystemEntry, rel: string, out: OsDropEntry[], depth: number, b: Budget): Promise<void> {
  visit(b);
  if (entry.isDirectory) {
    if (depth > b.maxDepth) throw new Error('フォルダが深すぎます');
    out.push({ rel, dir: true });
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // 中身は 100 件ずつ返るので、読んだ分から順に処理する（全部を集めてから数えない）
    for (;;) {
      const batch = await readBatch(reader);
      if (batch.length === 0) return;
      for (const child of batch) {
        await walkFsEntry(child, joinRel(rel, child.name), out, depth + 1, b);
      }
    }
  }
  const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
  out.push({ rel, dir: false, size: file.size, read: async () => file });
}

/** 中身の次の 100 件（空なら終わり） */
function readBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
}
