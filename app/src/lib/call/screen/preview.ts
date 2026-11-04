/**
 * 設定の「プレビュー」: 撮った 1 枚を、今の設定で符号化した見本と、1 フレームの大きさ・帯域の見積もり。
 * 純粋な部分（encodePreview）は canvas を引数で受けるのでテストできる。画面を撮るのは呼び出し側（snapshot をクリックしたときだけ）。
 */
import { encodeFrame, estimateBandwidth, fitSize, QUALITY_PRESETS, type EncodeCanvas } from './codec';
import type { ScreenSettingsValue } from './types';

export type PreviewResult = {
  /** data: の URL（img の src に入れられる） */
  src: string;
  mime: string;
  width: number;
  height: number;
  /** 1 フレームの画像の大きさ（バイト） */
  imageBytes: number;
  /** 動き続けたときの帯域（バイト / 秒）。サーバーの予算で頭打ち */
  bytesPerSec: number;
  capped: boolean;
};

/** 撮った画像を、今の設定の画質（長辺）まで縮小して符号化する */
export function encodePreview(source: unknown, srcSize: { width: number; height: number }, value: ScreenSettingsValue, makeCanvas: () => EncodeCanvas): PreviewResult {
  const preset = QUALITY_PRESETS[value.quality] ?? QUALITY_PRESETS.p720!;
  const size = fitSize(srcSize.width, srcSize.height, preset.maxEdge);
  const out = encodeFrame(makeCanvas(), source, size.w, size.h, { color: value.color, quality: preset.quality, format: null });
  const band = estimateBandwidth(out.b64.length, value.fps);
  return {
    src: `data:${out.mime};base64,${out.b64}`,
    mime: out.mime,
    width: size.w,
    height: size.h,
    imageBytes: band.imageBytes,
    bytesPerSec: band.bytesPerSec,
    capped: band.capped,
  };
}

/** 撮った画像（data: の URL）を canvas に描いて、符号化に使える形にする（DOM を使う。呼ぶまで触らない） */
export function loadSnapshotCanvas(dataUrl: string): Promise<{ canvas: HTMLCanvasElement; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const width = img.naturalWidth;
      const height = img.naturalHeight;
      if (width <= 0 || height <= 0) {
        reject(new Error('画像の大きさが分かりません'));
        return;
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('canvas を使えません'));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      resolve({ canvas, width, height });
    };
    img.onerror = () => reject(new Error('画像を読めませんでした'));
    img.src = dataUrl;
  });
}

/** 画面の canvas を作る（DOM の canvas。符号化の関数に渡す） */
export function newCanvas(): EncodeCanvas {
  return document.createElement('canvas') as unknown as EncodeCanvas;
}
