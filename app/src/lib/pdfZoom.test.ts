import { describe, expect, it } from 'vitest';
import { anchoredScroll, clampZoom, stepZoom } from './pdfZoom';

describe('PDF のプレビューの拡大・縮小', () => {
  it('倍率は 1（幅に合わせる）〜 4 に収める', () => {
    expect(clampZoom(0.5)).toBe(1);
    expect(clampZoom(2.3)).toBe(2.3);
    expect(clampZoom(9)).toBe(4);
  });

  it('ボタンは段階を進む。ピンチで段階の間にいても、その先の段階へ', () => {
    expect(stepZoom(1, 1)).toBe(1.5);
    expect(stepZoom(1.7, 1)).toBe(2);
    expect(stepZoom(1.7, -1)).toBe(1.5);
    expect(stepZoom(4, 1)).toBe(4);
    expect(stepZoom(1, -1)).toBe(1);
  });

  it('指（カーソル）の下の場所が、拡大のあとも同じ所に残る', () => {
    // 枠の (100, 200) の下は、中身の (100, 1200)。2 倍にすると (200, 2400) なので、そこが (100, 200) に来るよう動かす
    expect(anchoredScroll({ left: 0, top: 1000 }, { x: 100, y: 200 }, 2)).toEqual({ left: 100, top: 2200 });
    // 縮小で左上を越えるときは 0 で止める
    expect(anchoredScroll({ left: 0, top: 0 }, { x: 100, y: 100 }, 0.5)).toEqual({ left: 0, top: 0 });
  });
});
