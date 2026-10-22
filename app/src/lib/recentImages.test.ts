import { afterEach, describe, expect, it } from 'vitest';
import { listRecentImages, RECENT_IMAGE_COUNT, setRecentImageSource, type RecentImage } from './recentImages';

afterEach(() => setRecentImageSource(null));

describe('最近の画像の出どころ', () => {
  it('既定は何もなし（空の一覧）', async () => {
    expect(await listRecentImages()).toEqual([]);
  });

  it('差し替えると、その出どころの一覧を件数の上限つきで返す', async () => {
    const seen: number[] = [];
    const img: RecentImage = { id: '1', name: 'a.png', thumbUrl: 'blob:x', load: async () => new File([], 'a.png') };
    setRecentImageSource(async (limit) => {
      seen.push(limit);
      return [img];
    });
    expect(await listRecentImages()).toEqual([img]);
    expect(seen).toEqual([RECENT_IMAGE_COUNT]);
  });

  it('null で既定に戻る', async () => {
    setRecentImageSource(async () => [{ id: '1', name: 'a', thumbUrl: '', load: async () => new File([], 'a') }]);
    setRecentImageSource(null);
    expect(await listRecentImages()).toEqual([]);
  });
});
