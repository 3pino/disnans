/**
 * 送る前の画像の縮小（SPEC 3.1 ファイル共有）。
 *
 * 寸法・サイズの見積もり・アニメーションの判定などは純粋関数（imageResize.test.ts で試す）。
 * canvas を使うのは readImageInfo と prepareUpload だけ。縮小は送信するときに行う。
 * 向きは createImageBitmap の imageOrientation: 'from-image' で直してから描く（EXIF の回転を反映する）。
 */

export type ResizeChoiceId = 'original' | 'large' | 'medium' | 'small';

export type ResizeChoice = { id: ResizeChoiceId; label: string; maxEdge: number | null };

/** 縮小の選択肢。既定は「元のまま」 */
export const RESIZE_CHOICES: readonly ResizeChoice[] = [
  { id: 'original', label: '元のまま', maxEdge: null },
  { id: 'large', label: '大', maxEdge: 2560 },
  { id: 'medium', label: '中', maxEdge: 1600 },
  { id: 'small', label: '小', maxEdge: 1024 },
];

/** 縮小の前に読んでおく画像の情報 */
export type ImageInfo = {
  /** 向きを直したあとの寸法 */
  width: number;
  height: number;
  /** 透過がある（縮小後を PNG にする） */
  alpha: boolean;
  /** アニメーション（APNG / アニメーション WebP）。縮小しない */
  animated: boolean;
};

/** 長辺を maxEdge に収める。小さい画像は拡大しない */
export function fitSize(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= maxEdge) return { width, height };
  const s = maxEdge / long;
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

/** 縮小後の形式。透過があれば PNG、なければ JPEG */
export function outputMime(alpha: boolean): 'image/png' | 'image/jpeg' {
  return alpha ? 'image/png' : 'image/jpeg';
}

/** 縮小後のファイル名（拡張子を形式に合わせる） */
export function outputName(name: string, mime: string): string {
  const stem = name.replace(/\.[^.]*$/, '') || 'image';
  return stem + (mime === 'image/png' ? '.png' : '.jpg');
}

/**
 * 縮小後のサイズの目安（バイト）。
 * 同じ形式（JPEG → JPEG、PNG → PNG）なら元のサイズに画素数の比をかける。
 * 形式が変わるとき（PNG → JPEG など）は画素数から見積もる（写真の JPEG は 1 画素あたり約 0.3 バイト）。
 */
export function estimateBytes(
  source: { size: number; mime: string; width: number; height: number },
  target: { width: number; height: number },
  alpha: boolean,
): number {
  const out = outputMime(alpha);
  if (source.mime === out) {
    const ratio = (target.width * target.height) / (source.width * source.height);
    return Math.round(source.size * ratio);
  }
  return Math.round(target.width * target.height * (out === 'image/png' ? 2 : 0.3));
}

export type ResizeOption = {
  choice: ResizeChoice;
  width: number;
  height: number;
  bytes: number;
  /** 元より小さくならない（縮小しない）ので選べない */
  disabled: boolean;
};

/** ダイアログに出す選択肢（寸法と、縮小後のサイズの目安） */
export function resizeOptions(info: ImageInfo, source: { size: number; mime: string }): ResizeOption[] {
  const base = { width: info.width, height: info.height };
  return RESIZE_CHOICES.map((choice) => {
    if (choice.maxEdge === null) return { choice, ...base, bytes: source.size, disabled: false };
    const fit = fitSize(info.width, info.height, choice.maxEdge);
    const shrinks = fit.width !== info.width || fit.height !== info.height;
    const bytes = shrinks ? estimateBytes({ ...source, ...base }, fit, info.alpha) : source.size;
    return { choice, ...fit, bytes, disabled: !shrinks };
  });
}

/** 縮小の対象にできるか（情報が読めて、アニメーションでないもの。GIF は読み込みの段階で外す） */
export function canResizeImage(info: ImageInfo | null | undefined): info is ImageInfo {
  return !!info && !info.animated;
}

/** RGBA の並びに透過（α < 255）があるか */
export function anyTransparent(rgba: ArrayLike<number>): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 255) return true;
  return false;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function ascii(b: Uint8Array, p: number, n: number): string {
  let s = '';
  for (let i = 0; i < n && p + i < b.length; i++) s += String.fromCharCode(b[p + i]);
  return s;
}

function u32be(b: Uint8Array, p: number): number {
  return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
}

function u32le(b: Uint8Array, p: number): number {
  return ((b[p + 3] << 24) | (b[p + 2] << 16) | (b[p + 1] << 8) | b[p]) >>> 0;
}

/**
 * ファイルの先頭から、アニメーション（APNG / アニメーション WebP）かを判定する。
 * head は先頭の数百 KB で足りる（acTL・ANIM・VP8X は画像データより前にある）。GIF は見ない。
 */
export function isAnimatedImage(head: Uint8Array): boolean {
  if (PNG_SIGNATURE.every((v, i) => head[i] === v)) {
    // APNG: IDAT（画像データ）より前に acTL がある
    let p = 8;
    while (p + 8 <= head.length) {
      const type = ascii(head, p + 4, 4);
      if (type === 'acTL') return true;
      if (type === 'IDAT' || type === 'IEND') return false;
      p += 12 + u32be(head, p);
    }
    return false;
  }
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') {
    let p = 12;
    while (p + 8 <= head.length) {
      const type = ascii(head, p, 4);
      const len = u32le(head, p + 4);
      if (type === 'ANIM') return true;
      // VP8X の先頭のバイトの 0x02 がアニメーションのフラグ
      if (type === 'VP8X' && p + 8 < head.length && (head[p + 8] & 0x02) !== 0) return true;
      if (type === 'VP8 ' || type === 'VP8L') return false;
      p += 8 + len + (len % 2);
    }
  }
  return false;
}

// ---- ここから canvas を使う部分 ----

/** 透過の判定に使う、縮小した見本の長辺 */
const SAMPLE_EDGE = 256;
/** 先頭から読むバイト数（アニメーションの判定用） */
const HEAD_BYTES = 256 * 1024;

type Surface = {
  ctx: CanvasRenderingContext2D;
  encode: (mime: string, quality: number) => Promise<Blob | null>;
};

/** OffscreenCanvas があればそれ、なければ canvas 要素 */
function makeSurface(width: number, height: number): Surface {
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(width, height);
    return {
      // OffscreenCanvasRenderingContext2D は描画の呼び出しが同じなので、型だけ合わせる
      ctx: c.getContext('2d') as unknown as CanvasRenderingContext2D,
      encode: (mime, quality) => c.convertToBlob({ type: mime, quality }),
    };
  }
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return {
    ctx: c.getContext('2d')!,
    encode: (mime, quality) => new Promise((resolve) => c.toBlob(resolve, mime, quality)),
  };
}

function sampleAlpha(bitmap: ImageBitmap): boolean {
  const scale = Math.min(1, SAMPLE_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const s = makeSurface(w, h);
  s.ctx.drawImage(bitmap, 0, 0, w, h);
  return anyTransparent(s.ctx.getImageData(0, 0, w, h).data);
}

/**
 * 画像の寸法・透過・アニメーションを読む。画像でない・GIF・読めないものは null（縮小の対象外）。
 * 選んだ時点で呼ぶ（サムネイルをタップしたときに寸法を出すため）。
 */
export async function readImageInfo(file: File): Promise<ImageInfo | null> {
  if (!file.type.startsWith('image/') || file.type === 'image/gif' || file.type === 'image/svg+xml') return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return null;
  }
  try {
    const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
    const alpha = (file.type === 'image/png' || file.type === 'image/webp') && sampleAlpha(bitmap);
    return { width: bitmap.width, height: bitmap.height, alpha, animated: isAnimatedImage(head) };
  } finally {
    bitmap.close();
  }
}

/**
 * 送信のときに、添付するファイルを用意する。maxEdge が null（元のまま）や、縮小する必要がなければ元のファイルを返す。
 * 縮小するときは JPEG（透過があれば PNG）にする。
 */
export async function prepareUpload(file: File, maxEdge: number | null): Promise<File> {
  if (maxEdge === null) return file;
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const target = fitSize(bitmap.width, bitmap.height, maxEdge);
    if (target.width === bitmap.width && target.height === bitmap.height) return file;
    const s = makeSurface(target.width, target.height);
    s.ctx.imageSmoothingEnabled = true;
    s.ctx.imageSmoothingQuality = 'high';
    s.ctx.drawImage(bitmap, 0, 0, target.width, target.height);
    const alpha =
      (file.type === 'image/png' || file.type === 'image/webp') &&
      anyTransparent(s.ctx.getImageData(0, 0, target.width, target.height).data);
    const mime = outputMime(alpha);
    const blob = await s.encode(mime, 0.9);
    if (!blob) throw new Error('画像を縮小できませんでした');
    return new File([blob], outputName(file.name, blob.type || mime), {
      type: blob.type || mime,
      lastModified: file.lastModified,
    });
  } finally {
    bitmap.close();
  }
}
