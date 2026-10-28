// OS からのフォルダ・ファイルのドロップの入力（dropFiles.ts）の試験。
// 既存の純粋関数（座標・矩形・ファイル名・MIME）は dropFiles.test.ts（HEAD）にある。
// ここで確かめるのは dropFiles.ts の関数だけ:
//   - Linux: Rust が列挙した根（os_drop_list）と、1 ファイルずつの読取（os_drop_read）・解放（os_drop_release）の呼び方
//   - Windows: HTML5 の入口（FileSystemEntry）から平らにする走査、上限、同名の根の付け替え
// 検証していないもの: コンポーネント内の upload・mkdir の順序と中止、finally での解放（ChatView・FileExplorer 側の関数で、この試験からは呼ばない）。
// Rust 側の列挙・読取の試験は app/src-tauri/src/os_drop_walk.rs（rustc --test）と os_drop_sessions.rs にある。
import { describe, expect, it, vi } from 'vitest';
import {
  dropRootsOf,
  entriesFromDropRoots,
  joinRel,
  OS_DROP_LIMITS,
  osDropEntries,
  osDropRelease,
  readOsDropFile,
  uniqueRootNames,
  withSuffix,
} from './dropFiles';

const listen = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/event', () => ({ listen }));
const { listenOsDrop, OS_DROP_EVENT } = await import('./dropFiles');

describe('joinRel', () => {
  it('親が空なら名前だけ。そうでなければ / で区切る', () => {
    expect(joinRel('', 'photos')).toBe('photos');
    expect(joinRel('photos', 'a.txt')).toBe('photos/a.txt');
  });
});

/** Rust の os_drop_list / os_drop_read / os_drop_release の代わり（呼ばれた命令を記録する） */
function fakeOsCall(
  listing: { entries: { rel: string; dir: boolean; size: number }[]; skipped: string[] },
  bytes: Uint8Array = new Uint8Array([1, 2, 3]),
) {
  const calls: [string, Record<string, unknown> | undefined][] = [];
  const call = (async (command: string, args?: Record<string, unknown>) => {
    calls.push([command, args]);
    if (command === 'os_drop_list') return listing;
    if (command === 'os_drop_read') return bytes.buffer;
    if (command === 'os_drop_release') return null;
    throw new Error('unknown ' + command);
  }) as Parameters<typeof osDropEntries>[1];
  return { call, calls };
}

describe('osDropEntries（Linux: Rust が列挙した根の中）', () => {
  it('フォルダは rel だけ。ファイルは大きさと、読むときの Rust 呼び出し（id と rel）を持つ', async () => {
    const f = fakeOsCall({
      entries: [
        { rel: 'photos', dir: true, size: 0 },
        { rel: 'photos/a.png', dir: false, size: 3 },
      ],
      skipped: ['photos/link'],
    });
    const { entries, skipped } = await osDropEntries(7, f.call);
    expect(skipped).toEqual(['photos/link']);
    expect(entries[0]).toEqual({ rel: 'photos', dir: true });
    const file = entries[1]!;
    if (file.dir) throw new Error('unreachable');
    expect(file.size).toBe(3);
    expect(f.calls).toEqual([['os_drop_list', { id: 7 }]]);
    const blob = await file.read();
    expect(blob.type).toBe('image/png');
    expect(f.calls[1]).toEqual(['os_drop_read', { id: 7, rel: 'photos/a.png' }]);
  });

  it('列挙が失敗したら例外（ごまかして空にしない）', async () => {
    const call = (async () => {
      throw 'このドロップは終わっています';
    }) as Parameters<typeof osDropEntries>[1];
    await expect(osDropEntries(1, call)).rejects.toBe('このドロップは終わっています');
  });

  it('readOsDropFile は読めた中身をそのまま Blob にする（文字が同じ）。失敗は例外', async () => {
    const ok = fakeOsCall({ entries: [], skipped: [] }, new TextEncoder().encode('hi'));
    const blob = await readOsDropFile(2, 'x/notes.txt', ok.call);
    expect(await blob.text()).toBe('hi');
    const bad = (async () => {
      throw 'ファイルが大きすぎます';
    }) as Parameters<typeof readOsDropFile>[2];
    await expect(readOsDropFile(2, 'x/big.bin', bad)).rejects.toBe('ファイルが大きすぎます');
  });

  it('osDropRelease は os_drop_release を ID つきで呼ぶ', async () => {
    const f = fakeOsCall({ entries: [], skipped: [] });
    await osDropRelease(5, f.call);
    expect(f.calls).toEqual([['os_drop_release', { id: 5 }]]);
  });
});

describe('listenOsDrop（Rust の os-drop イベント）', () => {
  it('イベント名は Rust と同じ', () => {
    expect(OS_DROP_EVENT).toBe('os-drop');
  });

  it('位置を物理から CSS ピクセルにして、同じペイロードで渡す', async () => {
    const handler = vi.fn();
    vi.stubGlobal('devicePixelRatio', 2);
    listen.mockImplementationOnce(async (name: string, cb: (e: { payload: unknown }) => void) => {
      expect(name).toBe(OS_DROP_EVENT);
      cb({ payload: { id: 3, error: null, roots: [{ name: 'a', dir: false }], skipped: [], position: { x: 300, y: 150 } } });
      return () => {};
    });
    await listenOsDrop(handler);
    expect(handler).toHaveBeenCalledWith({ id: 3, error: null, roots: [{ name: 'a', dir: false }], skipped: [], position: { x: 150, y: 75 } });
    vi.unstubAllGlobals();
  });

  it('上限のエラーは id なしで届き、位置が無いものは null のまま', async () => {
    const handler = vi.fn();
    listen.mockImplementationOnce(async (_name: string, cb: (e: { payload: unknown }) => void) => {
      cb({ payload: { id: null, error: 'ドロップが多すぎます', roots: [], skipped: [], position: null } });
      return () => {};
    });
    await listenOsDrop(handler);
    expect(handler).toHaveBeenCalledWith({ id: null, error: 'ドロップが多すぎます', roots: [], skipped: [], position: null });
  });
});

/** ブラウザーの FileSystemEntry の代わり（readEntries は batchSize ずつ返す。読み終えたら空） */
function fsFile(name: string, size: number, text?: string) {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (ok: (f: File) => void) => ok(new File([text ?? new Uint8Array(size)], name)),
  };
}
function fsDir(name: string, children: unknown[], batchSize = 1) {
  let served = 0;
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => ({
      readEntries: (ok: (xs: unknown[]) => void) => {
        const batch = children.slice(served, served + batchSize);
        served += batch.length;
        ok(batch);
      },
    }),
  };
}

describe('entriesFromDropRoots（Windows: HTML5 の入口から平らにする）', () => {
  it('フォルダの中まで親が先に並ぶ。空のフォルダも入る。読みは後から', async () => {
    const roots = [
      fsDir('photos', [fsFile('a.txt', 3), fsDir('sub', [fsFile('deep.bin', 10)], 1), fsDir('empty', [])]),
      fsFile('loose.png', 1),
    ] as unknown as FileSystemEntry[];
    const entries = await entriesFromDropRoots(roots);
    expect(entries.map((e) => (e.dir ? `${e.rel}/` : e.rel))).toEqual([
      'photos/',
      'photos/a.txt',
      'photos/sub/',
      'photos/sub/deep.bin',
      'photos/empty/',
      'loose.png',
    ]);
    const deep = entries[3]!;
    if (deep.dir) throw new Error('unreachable');
    expect(deep.size).toBe(10);
    expect((await deep.read()).size).toBe(10);
  });

  it('ファイルの read() は中身をそのまま返す', async () => {
    const entries = await entriesFromDropRoots([fsFile('x.txt', 0, 'hello')] as unknown as FileSystemEntry[]);
    const only = entries[0]!;
    if (only.dir) throw new Error('unreachable');
    expect(await (await only.read()).text()).toBe('hello');
  });

  it('ディレクトリの中身は少しずつしか返らないので、空になるまで読み続ける', async () => {
    const children = Array.from({ length: 5 }, (_, i) => fsFile(`f${i}.txt`, 1));
    const entries = await entriesFromDropRoots([fsDir('d', children, 2)] as unknown as FileSystemEntry[]);
    expect(entries.map((e) => e.rel)).toEqual(['d', 'd/f0.txt', 'd/f1.txt', 'd/f2.txt', 'd/f3.txt', 'd/f4.txt']);
  });
});

describe('dropRootsOf（ドロップの中で入口を取る）', () => {
  it('ファイルの項目だけ、webkitGetAsEntry の入口を取る（文字列・null の入口は除く）', () => {
    const a = fsFile('a.txt', 1);
    const dt = {
      items: [
        { kind: 'file', webkitGetAsEntry: () => a },
        { kind: 'string', webkitGetAsEntry: () => null },
        { kind: 'file', webkitGetAsEntry: () => null },
      ],
    } as unknown as DataTransfer;
    expect(dropRootsOf(dt)).toEqual([a]);
  });

  it('DataTransfer が無い（null・undefined）ときは空', () => {
    expect(dropRootsOf(null)).toEqual([]);
    expect(dropRootsOf(undefined)).toEqual([]);
  });
});

describe('entriesFromDropRoots の上限（Rust の walker と同じ数え方）', () => {
  it('上限の既定は Rust と同じ（件数 50,000・深さ 32）', () => {
    expect(OS_DROP_LIMITS).toEqual({ maxEntries: 50_000, maxDepth: 32 });
  });

  it('項目が上限を超えたら止める（中身を全部集めてから数えない）', async () => {
    const wide = () => [fsDir('wide', Array.from({ length: 200 }, (_, i) => fsFile(`f${i}`, 1)), 100)] as unknown as FileSystemEntry[];
    await expect(entriesFromDropRoots(wide(), { maxEntries: 50, maxDepth: 32 })).rejects.toThrow('項目が多すぎます');
    expect((await entriesFromDropRoots(wide(), { maxEntries: 201, maxDepth: 32 })).length).toBe(201);
  });

  it('終わらない中身（いつまでも返る読み）でも、上限で必ず止まる', async () => {
    const endless = {
      isFile: false,
      isDirectory: true,
      name: 'loop',
      createReader: () => ({ readEntries: (ok: (xs: unknown[]) => void) => ok([fsFile('x', 1), fsFile('y', 1)]) }),
    };
    await expect(entriesFromDropRoots([endless] as unknown as FileSystemEntry[], { maxEntries: 10, maxDepth: 32 })).rejects.toThrow(
      '項目が多すぎます',
    );
  });

  it('深さが上限を超えたら止める', async () => {
    const deep = () => [fsDir('a', [fsDir('b', [fsDir('c', [fsFile('f', 1)])])])] as unknown as FileSystemEntry[];
    await expect(entriesFromDropRoots(deep(), { maxEntries: 100, maxDepth: 2 })).rejects.toThrow('フォルダが深すぎます');
    expect((await entriesFromDropRoots(deep(), { maxEntries: 100, maxDepth: 3 })).length).toBe(4);
  });
});

describe('同じ名前の根（Windows の HTML5 のドロップ）', () => {
  it('名前の付け方は Rust と同じ（拡張子の前・フォルダは後ろ・先頭と末尾の点は拡張子でない）', () => {
    expect(withSuffix('photo.jpg', 2, false)).toBe('photo (2).jpg');
    expect(withSuffix('a.tar.gz', 3, false)).toBe('a.tar (3).gz');
    expect(withSuffix('docs', 2, true)).toBe('docs (2)');
    expect(withSuffix('my.folder', 2, true)).toBe('my.folder (2)');
    expect(withSuffix('.rc', 2, false)).toBe('.rc (2)');
    expect(withSuffix('trailing.', 2, false)).toBe('trailing. (2)');
  });

  it('先に来たものが元の名前を取り、次からは空いている番号を使う（既存の名前も飛ばす）', () => {
    expect(
      uniqueRootNames([
        { name: 'photo.jpg', dir: false },
        { name: 'photo (2).jpg', dir: false },
        { name: 'photo.jpg', dir: false },
      ]),
    ).toEqual(['photo.jpg', 'photo (2).jpg', 'photo (3).jpg']);
  });

  it('entriesFromDropRoots: 同名の根は別の名前で平らにする（上書きしない）', async () => {
    const roots = [
      fsFile('photo.jpg', 1),
      fsFile('photo.jpg', 2),
      fsDir('docs', [fsFile('a.txt', 3)]),
      fsDir('docs', [fsFile('a.txt', 4)]),
    ] as unknown as FileSystemEntry[];
    const entries = await entriesFromDropRoots(roots);
    expect(entries.map((e) => e.rel)).toEqual(['photo.jpg', 'photo (2).jpg', 'docs', 'docs/a.txt', 'docs (2)', 'docs (2)/a.txt']);
    expect(entries[1]).toMatchObject({ dir: false, size: 2 });
  });
});
