import { afterEach, describe, expect, it } from 'vitest';
import {
  listRecentImages,
  permissionNotice,
  RECENT_IMAGE_MAX,
  recentGridFit,
  RECENT_TILE_MAX,
  RECENT_TILE_MIN,
  requestRecentImagesPermission,
  setRecentImageSource,
} from './recentImages';
import { base64ToBytes, nativeRecentImageSource, toRecentImage, type RecentImageInfo } from './recentImagesNative';

afterEach(() => setRecentImageSource(null));

const info = (id: string, over: Partial<RecentImageInfo> = {}): RecentImageInfo => ({
  id,
  name: `${id}.jpg`,
  mime: 'image/jpeg',
  modified: 1000,
  width: 10,
  height: 20,
  thumb: `data:image/jpeg;base64,${id}`,
  ...over,
});

describe('最近の画像（出どころ）', () => {
  it('既定（テスト中の Tauri 外）は空で granted', async () => {
    expect(await listRecentImages()).toEqual({ permission: 'granted', images: [] });
    expect(await requestRecentImagesPermission()).toBe('granted');
  });

  it('差し替えると、その出どころの一覧を件数の上限つきで返す', async () => {
    const seen: number[] = [];
    setRecentImageSource({
      list: async (limit) => {
        seen.push(limit);
        return { permission: 'limited', images: [toRecentImage(info('a'), async () => new File([], 'a.jpg'))] };
      },
      requestPermission: async () => 'limited',
    });
    const res = await listRecentImages();
    expect(res.permission).toBe('limited');
    expect(res.images.map((i) => i.id)).toEqual(['a']);
    expect(seen).toEqual([RECENT_IMAGE_MAX]);
    expect(await requestRecentImagesPermission()).toBe('limited');
  });

  it('取る件数の上限は 24（実際に並べるのは、画面に入るだけ）', async () => {
    const seen: number[] = [];
    setRecentImageSource({
      list: async (limit) => (seen.push(limit), { permission: 'granted', images: [] }),
      requestPermission: async () => 'granted',
    });
    await listRecentImages();
    expect(seen).toEqual([24]);
    expect(RECENT_IMAGE_MAX).toBe(24);
  });
});

describe('recentGridFit（枠の列数・タイルの幅・入る件数）', () => {
  const gap = 8;
  it('狭い画面（幅 358・高さの上限 422）: 3 列、タイル 114、3 行の 9 件', () => {
    expect(recentGridFit({ width: 358, maxHeight: 422, gap })).toEqual({ cols: 3, tile: 114, rows: 3, capacity: 9 });
  });
  it('広い画面: 列は幅から決まり、タイルは最大の幅を超えない', () => {
    const f = recentGridFit({ width: 1200, maxHeight: 2000, gap });
    expect(f.tile).toBeLessThanOrEqual(RECENT_TILE_MAX);
    expect(f.tile).toBeGreaterThanOrEqual(RECENT_TILE_MIN);
    expect(f.cols).toBe(Math.floor((1200 + gap) / (RECENT_TILE_MIN + gap)));
  });
  it('高さの上限を超えない（行数 × タイル + 隙間 ≦ 上限）', () => {
    for (const maxHeight of [120, 300, 422, 700]) {
      const f = recentGridFit({ width: 358, maxHeight, gap });
      expect(f.rows * f.tile + (f.rows - 1) * gap).toBeLessThanOrEqual(Math.max(maxHeight, f.tile));
    }
  });
  it('上限（24 件）で止める。画面が大きくても増えない', () => {
    expect(recentGridFit({ width: 2400, maxHeight: 5000, gap }).capacity).toBe(24);
  });
  it('高さが足りないときも、1 行は取る（空の枠にしない）', () => {
    expect(recentGridFit({ width: 358, maxHeight: 10, gap }).capacity).toBeGreaterThanOrEqual(3);
  });
  it('幅が分からないとき（0）は上限の件数（列は 1）', () => {
    expect(recentGridFit({ width: 0, maxHeight: 400, gap })).toMatchObject({ cols: 1, capacity: 24 });
  });
});

describe('Android の出どころ（Tauri のコマンドの形）', () => {
  it('recent_images の結果を、パネルの形にする（thumb を表示に使う）', async () => {
    const calls: Array<[string, unknown]> = [];
    const src = nativeRecentImageSource('android', {
      invoke: async <T,>(cmd: string, args?: Record<string, unknown>) => {
        calls.push([cmd, args]);
        return { permission: 'granted', images: [info('p1')] } as T;
      },
    });
    const res = await src.list(12);
    expect(calls[0]).toEqual(['plugin:notifier|recent_images', { limit: 12 }]);
    expect(res.permission).toBe('granted');
    expect(res.images[0]).toMatchObject({ id: 'p1', name: 'p1.jpg', thumbUrl: 'data:image/jpeg;base64,p1' });
  });

  it('サムネイルが null（作れない形式）なら thumbUrl は null。preview で原本から blob URL を作る', async () => {
    const src = nativeRecentImageSource('android', {
      invoke: async <T,>(cmd: string) => {
        if (cmd === 'plugin:notifier|read_image') return { name: 'x.avif', mime: 'image/avif', data: btoa('AV') } as T;
        return { permission: 'granted', images: [info('p3', { thumb: null, name: 'x.avif', mime: 'image/avif' })] } as T;
      },
    });
    const [img] = (await src.list(3)).images;
    expect(img.thumbUrl).toBeNull();
    // jsdom が blob URL を作れない環境でも落ちないよう、関数の呼び出しだけを確かめる
    URL.createObjectURL = (() => 'blob:test') as typeof URL.createObjectURL;
    expect(await img.preview()).toBe('blob:test');
  });

  it('画像を押したら read_image を呼び、base64 を File にする', async () => {
    const src = nativeRecentImageSource('android', {
      invoke: async <T,>(cmd: string) => {
        if (cmd === 'plugin:notifier|read_image') return { name: 'x.png', mime: 'image/png', data: btoa('PNG') } as T;
        return { permission: 'granted', images: [info('p2')] } as T;
      },
    });
    const [img] = (await src.list(1)).images;
    const f = await img.load();
    expect(f.name).toBe('x.png');
    expect(f.type).toBe('image/png');
    expect(await f.text()).toBe('PNG');
  });

  it('許可は plugin:notifier|request_recent_images_permission で求める', async () => {
    const src = nativeRecentImageSource('android', {
      invoke: async <T,>(cmd: string) => {
        expect(cmd).toBe('plugin:notifier|request_recent_images_permission');
        return { permission: 'denied' } as T;
      },
    });
    expect(await src.requestPermission()).toBe('denied');
  });
});

describe('デスクトップの出どころ', () => {
  it('recent_images の id は絶対パス。押したら既存のパス経路（readFile）で読む', async () => {
    const reads: string[] = [];
    const src = nativeRecentImageSource('desktop', {
      invoke: async <T,>(cmd: string) => {
        expect(cmd).toBe('recent_images');
        return { permission: 'granted', images: [info('C:/Pictures/a.jpg', { name: 'a.jpg' })] } as T;
      },
      readDesktopFile: async (path) => {
        reads.push(path);
        return new Uint8Array(new ArrayBuffer(3)).map((_, i) => i + 1) as Uint8Array<ArrayBuffer>;
      },
    });
    const [img] = (await src.list(5)).images;
    const f = await img.load();
    expect(reads).toEqual(['C:/Pictures/a.jpg']);
    expect(f.name).toBe('a.jpg');
    expect(f.type).toBe('image/jpeg');
    expect(f.size).toBe(3);
  });

  it('許可は常に granted（求めない）', async () => {
    const src = nativeRecentImageSource('desktop', { invoke: async () => ({}) as never });
    expect(await src.requestPermission()).toBe('granted');
  });
});

describe('permissionNotice', () => {
  it('denied と limited には案内、granted には無し', () => {
    expect(permissionNotice('granted')).toBeNull();
    expect(permissionNotice('denied')).toContain('設定 > アプリ > disnans > 権限');
    expect(permissionNotice('limited')).toContain('選んだ写真だけ');
  });
});

describe('base64ToBytes', () => {
  it('base64 をバイト列にする', () => {
    expect([...base64ToBytes(btoa('AB'))]).toEqual([65, 66]);
  });
});
