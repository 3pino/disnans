// フォルダごとの表示（explorerDirs）の純粋な部品のテスト。上限・並び・継承・旧い保存の読み替え。
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DIR_VIEW,
  EXPLORER_DIRS_MAX,
  EXPLORER_DIRS_MAX_BYTES,
  inheritedDirView,
  legacyExplorerDirs,
  parseDirViewMap,
  withDirView,
  type DirView,
  type DirViewMap,
} from './explorerDirs';
import { parentOf } from './sharedPath';

const GRID: DirView = { view: 'grid', sortKey: 'modified', sortOrder: 'desc' };

function reader(values: Record<string, string>): (key: string) => string | null {
  return (key) => (key in values ? values[key] : null);
}

describe('parseDirViewMap（保存された値を読む）', () => {
  it('知らない値・型の違う値は捨て、残りは順番のまま。旧い「一覧」は詳細として読む', () => {
    const map = parseDirViewMap({
      a: { view: 'hologram', sortKey: 'name', sortOrder: 'asc' },
      b: 3,
      c: { view: 'list', sortKey: 'size', sortOrder: 'desc' },
      d: { view: 'grid', sortKey: 'name', sortOrder: 'asc', extra: 1 },
    });
    expect(Object.keys(map)).toEqual(['c', 'd']);
    expect(map.c).toEqual({ view: 'details', sortKey: 'size', sortOrder: 'desc' });
  });

  it('オブジェクトでない値（配列・null・文字列）は空', () => {
    expect(parseDirViewMap(null)).toEqual({});
    expect(parseDirViewMap([1, 2])).toEqual({});
    expect(parseDirViewMap('x')).toEqual({});
  });

  it('上限（200 件）を超えたら、先頭（古いもの）から捨てる', () => {
    const big: Record<string, DirView> = {};
    for (let i = 0; i < EXPLORER_DIRS_MAX + 5; i++) big[`d${i}`] = DEFAULT_DIR_VIEW;
    const map = parseDirViewMap(big);
    expect(Object.keys(map)).toHaveLength(EXPLORER_DIRS_MAX);
    expect(map).not.toHaveProperty('d0');
    expect(map).toHaveProperty(`d${EXPLORER_DIRS_MAX + 4}`);
  });
});

describe('withDirView（変えたものを最後に置き、上限に収める）', () => {
  it('同じフォルダを変えると、そのフォルダが末尾に来る（元の map は変えない）', () => {
    const base: DirViewMap = { a: DEFAULT_DIR_VIEW, b: DEFAULT_DIR_VIEW };
    const next = withDirView(base, 'a', GRID);
    expect(Object.keys(next)).toEqual(['b', 'a']);
    expect(next.a).toEqual(GRID);
    expect(base.a).toEqual(DEFAULT_DIR_VIEW);
  });

  it('件数の上限（200）を超えたら、いちばん古く変えたものを捨てる', () => {
    let map: DirViewMap = {};
    for (let i = 0; i < EXPLORER_DIRS_MAX; i++) map = withDirView(map, `d${i}`, DEFAULT_DIR_VIEW);
    expect(Object.keys(map)).toHaveLength(EXPLORER_DIRS_MAX);
    map = withDirView(map, 'new', GRID);
    expect(Object.keys(map)).toHaveLength(EXPLORER_DIRS_MAX);
    expect(map).not.toHaveProperty('d0');
    expect(map).toHaveProperty('d1');
    expect(map.new).toEqual(GRID);
  });

  it('大きさの上限（24 KiB）を超えたら、古いものから捨てて上限の内に収める', () => {
    const long = 'x'.repeat(400);
    let map: DirViewMap = {};
    for (let i = 0; i < 150; i++) map = withDirView(map, `${long}${i}`, DEFAULT_DIR_VIEW);
    expect(new TextEncoder().encode(JSON.stringify(map)).length).toBeLessThanOrEqual(EXPLORER_DIRS_MAX_BYTES);
    expect(map).toHaveProperty(`${long}149`);
    expect(map).not.toHaveProperty(`${long}0`);
  });
});

describe('inheritedDirView（決めていないフォルダは、上のフォルダに従う）', () => {
  it('いちばん近い上の設定。どこにも無ければ既定', () => {
    const map: DirViewMap = { docs: GRID, '': { view: 'details', sortKey: 'size', sortOrder: 'asc' } };
    expect(inheritedDirView(map, 'docs/a/b', parentOf)).toEqual(GRID);
    expect(inheritedDirView(map, 'other', parentOf)).toEqual({ view: 'details', sortKey: 'size', sortOrder: 'asc' });
    expect(inheritedDirView({}, 'x/y', parentOf)).toEqual(DEFAULT_DIR_VIEW);
    // 名前が前方一致するだけのフォルダには効かない
    expect(inheritedDirView({ docs: GRID }, 'docsx', parentOf)).toEqual(DEFAULT_DIR_VIEW);
  });
});

describe('legacyExplorerDirs（以前の localStorage の読み替え）', () => {
  it('旧い一覧（disnans.explorer.dirs）が読めれば、それを使う', () => {
    const read = reader({ 'disnans.explorer.dirs': JSON.stringify({ a: GRID }) });
    expect(legacyExplorerDirs(read)).toEqual({ a: GRID });
  });

  it('旧い一覧が壊れていれば、端末全体の旧い設定（view・sort）をルートに引き継ぐ', () => {
    const read = reader({ 'disnans.explorer.dirs': '{', 'disnans.explorer.view': 'grid', 'disnans.explorer.sort': 'size:desc' });
    expect(legacyExplorerDirs(read)).toEqual({ '': { view: 'grid', sortKey: 'size', sortOrder: 'desc' } });
  });

  it('旧い設定の一部だけでも引き継ぐ（残りは既定）。何も無ければ null', () => {
    expect(legacyExplorerDirs(reader({ 'disnans.explorer.view': 'list' }))).toEqual({ '': DEFAULT_DIR_VIEW });
    expect(legacyExplorerDirs(reader({ 'disnans.explorer.sort': 'bogus' }))).toBeNull();
    expect(legacyExplorerDirs(reader({}))).toBeNull();
  });
});

describe('大きさの予算（UTF-8 のバイト・長いパス・日本語のパス）', () => {
  it('日本語の長いパスでも、件数と UTF-8 の大きさの両方が上限の内に収まり、新しいものは残る', () => {
    const name = 'あ'.repeat(120); // 1 文字 3 バイト → 1 件 360 バイト超
    let map: DirViewMap = {};
    for (let i = 0; i < 200; i++) {
      map = withDirView(map, `${name}${i}`, GRID);
      const bytes = new TextEncoder().encode(JSON.stringify(map)).length;
      expect(bytes).toBeLessThanOrEqual(EXPLORER_DIRS_MAX_BYTES);
      expect(Object.keys(map).length).toBeLessThanOrEqual(EXPLORER_DIRS_MAX);
    }
    expect(Object.keys(map).length).toBeLessThan(200);
    expect(map).toHaveProperty(`${name}199`);
    expect(map).not.toHaveProperty(`${name}0`);
  });

  it('1 件だけでも大きさの上限を超えるものは覚えない（サーバーに送れない値を作らない）', () => {
    const huge = 'x'.repeat(EXPLORER_DIRS_MAX_BYTES * 2);
    const map = withDirView({}, huge, DEFAULT_DIR_VIEW);
    expect(map).toEqual({});
  });
});
