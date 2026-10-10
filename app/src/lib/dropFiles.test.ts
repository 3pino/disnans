import { describe, expect, it } from 'vitest';
import { fileNameOf, mimeFromName, pointInRect, toCssPoint } from './dropFiles';

describe('toCssPoint', () => {
  it('物理ピクセルを CSS ピクセルにする', () => {
    expect(toCssPoint({ x: 300, y: 150 }, 1.5)).toEqual({ x: 200, y: 100 });
  });
  it('倍率が不正なら 1 倍として扱う', () => {
    expect(toCssPoint({ x: 10, y: 20 }, 0)).toEqual({ x: 10, y: 20 });
  });
});

describe('pointInRect', () => {
  const r = { left: 10, top: 20, right: 110, bottom: 220 };
  it('中にある点', () => {
    expect(pointInRect({ x: 50, y: 100 }, r)).toBe(true);
  });
  it('左上の端は含む、右下の端は含まない', () => {
    expect(pointInRect({ x: 10, y: 20 }, r)).toBe(true);
    expect(pointInRect({ x: 110, y: 100 }, r)).toBe(false);
    expect(pointInRect({ x: 50, y: 220 }, r)).toBe(false);
  });
  it('外にある点', () => {
    expect(pointInRect({ x: 5, y: 100 }, r)).toBe(false);
  });
});

describe('fileNameOf', () => {
  it('Linux と Windows の区切りの両方を扱う', () => {
    expect(fileNameOf('/home/a/pic.png')).toBe('pic.png');
    expect(fileNameOf('C:\\Users\\a\\doc.pdf')).toBe('doc.pdf');
  });
  it('名前が取れないときは file', () => {
    expect(fileNameOf('/')).toBe('file');
  });
});

describe('mimeFromName', () => {
  it('画像は画像の型になる（大文字の拡張子も）', () => {
    expect(mimeFromName('a.PNG')).toBe('image/png');
    expect(mimeFromName('b.jpeg')).toBe('image/jpeg');
  });
  it('分からない拡張子と拡張子なしは汎用の型', () => {
    expect(mimeFromName('a.xyz')).toBe('application/octet-stream');
    expect(mimeFromName('README')).toBe('application/octet-stream');
  });
});
