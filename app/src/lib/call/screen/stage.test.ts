import { describe, expect, it } from 'vitest';
import { canWebPip, clampView, containSize, doubleTapView, isDoubleTap, pinchView, wheelAction, zoomAt, MAX_ZOOM, MIN_ZOOM } from './stage';

const wheel = (o: Partial<Parameters<typeof wheelAction>[0]>) => ({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, ...o });

describe('containSize', () => {
  it('縦横比を保って舞台に収める。小さい画像は広げる', () => {
    expect(containSize({ w: 1600, h: 900 }, { w: 800, h: 800 })).toEqual({ w: 800, h: 450 });
    expect(containSize({ w: 100, h: 50 }, { w: 400, h: 400 })).toEqual({ w: 400, h: 200 });
    expect(containSize({ w: 0, h: 50 }, { w: 400, h: 400 })).toEqual({ w: 0, h: 0 });
  });
});

describe('wheelAction', () => {
  it('Ctrl / Meta + ホイールは拡大縮小（上へ回すと拡大）', () => {
    const up = wheelAction(wheel({ deltaY: -10, ctrlKey: true }), { scale: 1, embedded: false, pageHeight: 800 });
    expect(up).toMatchObject({ kind: 'zoom' });
    expect((up as { factor: number }).factor).toBeGreaterThan(1);
    const meta = wheelAction(wheel({ deltaY: 10, metaKey: true }), { scale: 2, embedded: true, pageHeight: 800 });
    expect((meta as { factor: number }).factor).toBeLessThan(1);
  });
  it('拡大中のホイールは移動。Shift で横', () => {
    expect(wheelAction(wheel({ deltaY: 30 }), { scale: 2, embedded: false, pageHeight: 800 })).toEqual({ kind: 'pan', dx: 0, dy: 30 });
    expect(wheelAction(wheel({ deltaY: 30, shiftKey: true }), { scale: 2, embedded: false, pageHeight: 800 })).toEqual({ kind: 'pan', dx: 30, dy: 0 });
  });
  it('等倍の埋め込みでは、ホイールはページのスクロールに譲る（拡大しない）', () => {
    expect(wheelAction(wheel({ deltaY: -10 }), { scale: 1, embedded: true, pageHeight: 800 })).toBeNull();
    expect(wheelAction(wheel({ deltaY: -10 }), { scale: 1, embedded: false, pageHeight: 800 })).toMatchObject({ kind: 'zoom' });
    expect(wheelAction(wheel({ deltaY: 10 }), { scale: 1, embedded: false, pageHeight: 800 })).toBeNull();
  });
  it('行単位のホイールをピクセルにそろえる', () => {
    expect(wheelAction(wheel({ deltaY: 2, deltaMode: 1 }), { scale: 2, embedded: false, pageHeight: 800 })).toEqual({ kind: 'pan', dx: 0, dy: 32 });
  });
});

describe('clampView / zoomAt / pinchView / doubleTapView', () => {
  it('画像が舞台からはみ出さないようにパンを収め、小さければ中央', () => {
    const stage = { w: 400, h: 300 };
    const img = { w: 400, h: 300 };
    expect(clampView({ scale: 2, x: 500, y: -500 }, stage, img)).toEqual({ scale: 2, x: 200, y: -150 });
    expect(clampView({ scale: 1, x: 50, y: 50 }, stage, img)).toEqual({ scale: 1, x: 0, y: 0 });
    expect(clampView({ scale: 99, x: 0, y: 0 }, stage, img).scale).toBe(MAX_ZOOM);
  });
  it('zoomAt は指した点を動かさない（倍率だけ変わる）', () => {
    const v = zoomAt({ scale: 1, x: 0, y: 0 }, 2, 100, 50);
    expect(v).toEqual({ scale: 2, x: -100, y: -50 });
    expect(zoomAt({ scale: 1, x: 0, y: 0 }, 0.1, 0, 0).scale).toBe(MIN_ZOOM);
  });
  it('pinchView: 指の間隔が 2 倍になれば倍率も 2 倍、中点の移動で移動する', () => {
    const v = pinchView({ scale: 1, x: 0, y: 0 }, { x: 0, y: 0 }, 100, { x: 10, y: 0 }, 200);
    expect(v.scale).toBe(2);
    expect(v.x).toBe(10);
  });
  it('ダブルタップは拡大、拡大中なら元に戻す', () => {
    expect(doubleTapView({ scale: 1, x: 0, y: 0 }, { x: 10, y: 10 }).scale).toBeGreaterThan(1);
    expect(doubleTapView({ scale: 3, x: 5, y: 5 }, { x: 10, y: 10 })).toEqual({ scale: 1, x: 0, y: 0 });
  });
});

describe('isDoubleTap / canWebPip', () => {
  it('近い場所を短い間隔で二度押したとき', () => {
    expect(isDoubleTap({ t: 0, x: 0, y: 0 }, { t: 200, x: 10, y: 10 })).toBe(true);
    expect(isDoubleTap({ t: 0, x: 0, y: 0 }, { t: 400, x: 10, y: 10 })).toBe(false);
    expect(isDoubleTap({ t: 0, x: 0, y: 0 }, { t: 200, x: 60, y: 0 })).toBe(false);
    expect(isDoubleTap(null, { t: 0, x: 0, y: 0 })).toBe(false);
  });
  it('デスクトップ PiP は両方の機能があるときだけ', () => {
    expect(canWebPip({ pictureInPictureEnabled: true }, { requestPictureInPicture: () => {} }, { captureStream: () => {} })).toBe(true);
    expect(canWebPip({ pictureInPictureEnabled: false }, { requestPictureInPicture: () => {} }, { captureStream: () => {} })).toBe(false);
    expect(canWebPip({ pictureInPictureEnabled: true }, {}, { captureStream: () => {} })).toBe(false);
    expect(canWebPip(undefined, undefined, undefined)).toBe(false);
  });
});
