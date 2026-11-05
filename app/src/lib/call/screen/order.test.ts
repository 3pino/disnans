import { describe, expect, it } from 'vitest';
import { LOCAL_VIEW, type ScreenSharer } from './types';
import { localFrameUrl, orderViews, viewLabel } from './order';

const sharer = (peer: string, userId: string, source: 'screen' | 'camera' = 'screen'): ScreenSharer => ({ peer, userId, source, dataUrl: `data:x/${peer}`, lastSeen: 0 });
const base = { sharing: false, source: 'screen' as const, localFrame: null, sharers: [] as ScreenSharer[] };
const nameOf = (id: string) => `名前:${id}`;

describe('通話の画面に並べる映像の順（自分の今のデバイス > 自分の別のデバイス > ほかの人）', () => {
  it('自分が共有していなければ、自分のこのデバイスは出ない', () => {
    expect(orderViews({ ...base, sharers: [sharer('o', 'other')] }, 'me').map((v) => v.peer)).toEqual(['o']);
  });
  it('自分の今のデバイスが先頭、次に自分の別のデバイス、最後にほかの人（同じ区分は届いた順）', () => {
    const sharers = [sharer('o1', 'other1'), sharer('m1', 'me'), sharer('o2', 'other2'), sharer('m2', 'me')];
    const v = orderViews({ ...base, sharing: true, localFrame: { mime: 'image/png', data: 'QUJD' } as never, sharers }, 'me');
    expect(v.map((e) => e.peer)).toEqual([LOCAL_VIEW, 'm1', 'm2', 'o1', 'o2']);
    expect(v.map((e) => [e.local, e.mine])).toEqual([[true, true], [false, true], [false, true], [false, false], [false, false]]);
  });
  it('自分のアカウントが分からなければ、全員ほかの人として扱う', () => {
    expect(orderViews({ ...base, sharers: [sharer('a', 'me')] }, null)[0]!.mine).toBe(false);
  });
  it('自分のこのデバイスの静止画は URL になる。カメラ（動画）は frame が無いので null', () => {
    expect(localFrameUrl({ localFrame: { mime: 'image/jpeg', data: 'QUJD' } as never })).toBe('data:image/jpeg;base64,QUJD');
    expect(orderViews({ ...base, sharing: true, source: 'camera' }, 'me')[0]).toMatchObject({ local: true, dataUrl: null, source: 'camera' });
  });
  it('名前: 自分のこのデバイスは「自分の…」、別のデバイスは「（別のデバイス）」付き', () => {
    const v = orderViews({ ...base, sharing: true, sharers: [sharer('m', 'me', 'camera'), sharer('o', 'other')] }, 'me');
    expect(v.map((e) => viewLabel(e, nameOf))).toEqual(['自分の画面', '名前:meのカメラ（別のデバイス）', '名前:otherの画面']);
  });
});
