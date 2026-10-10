/**
 * 送る前の画像の切り抜き（トリミング・SPEC 3.1 ファイル共有）。
 *
 * 切り抜く範囲（CropRect）は元の画像の画素で持つ。ダイアログの表示との変換・範囲の計算・比率の計算は純粋関数
 * （imageCrop.test.ts で試す）。canvas を使うのは readImageInfo と prepareUpload だけ。切り抜きは送信するときに行う。
 * 向きは createImageBitmap の imageOrientation: 'from-image' で直してから描く（EXIF の回転を反映する）。
 */

/** 切り抜く範囲（元の画像の画素。整数） */
export type CropRect = { x: number; y: number; w: number; h: number };

export type ImageSize = { width: number; height: number };

/** 切り抜きの一番小さい辺（元の画像の画素）。画像がこれより小さいときは画像の辺まで */
export const MIN_CROP = 32;

/** 比率の選択肢 */
export type AspectId = 'free' | 'square' | 'r4x3' | 'r16x9' | 'original';

export const ASPECT_CHOICES: readonly { id: AspectId; label: string }[] = [
  { id: 'free', label: '自由' },
  { id: 'square', label: '1:1' },
  { id: 'r4x3', label: '4:3' },
  { id: 'r16x9', label: '16:9' },
  { id: 'original', label: '元の比率' },
];

/** 4:3 と 16:9 は、縦にもできる（1:1 と元の比率は向きを選ばない） */
export function isOrientable(id: AspectId): boolean {
  return id === 'r4x3' || id === 'r16x9';
}

/** 比（幅 / 高さ）。自由なら null。portrait のときは縦長にする */
export function aspectRatio(id: AspectId, img: ImageSize, portrait: boolean): number | null {
  switch (id) {
    case 'free':
      return null;
    case 'square':
      return 1;
    case 'r4x3':
      return portrait ? 3 / 4 : 4 / 3;
    case 'r16x9':
      return portrait ? 9 / 16 : 16 / 9;
    case 'original':
      return img.width / img.height;
  }
}

/** 画像全体の範囲 */
export function fullRect(img: ImageSize): CropRect {
  return { x: 0, y: 0, w: img.width, h: img.height };
}

/** 切り抜きの最小の幅と高さ */
export function minSize(img: ImageSize): { w: number; h: number } {
  return { w: Math.min(MIN_CROP, img.width), h: Math.min(MIN_CROP, img.height) };
}

/** 範囲が画像全体と同じか */
export function isFullRect(r: CropRect, img: ImageSize): boolean {
  return r.x === 0 && r.y === 0 && r.w === img.width && r.h === img.height;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 比率を保って、画像に入る一番大きい範囲を中央に置く（比率が null なら画像全体） */
export function initialRect(img: ImageSize, ratio: number | null): CropRect {
  if (ratio === null) return fullRect(img);
  let w = img.width;
  let h = img.height;
  if (w / h > ratio) w = Math.round(h * ratio);
  else h = Math.round(w / ratio);
  w = Math.max(1, w);
  h = Math.max(1, h);
  return { x: Math.round((img.width - w) / 2), y: Math.round((img.height - h) / 2), w, h };
}

/** 整数にして、画像の中に収め、最小の大きさを守る（比率は保たない） */
export function clampRect(r: CropRect, img: ImageSize): CropRect {
  const m = minSize(img);
  const w = clamp(Math.round(r.w), m.w, img.width);
  const h = clamp(Math.round(r.h), m.h, img.height);
  return {
    x: clamp(Math.round(r.x), 0, img.width - w),
    y: clamp(Math.round(r.y), 0, img.height - h),
    w,
    h,
  };
}

/** 範囲を、ドラッグの分だけ動かす（画像の外へは出さない）。start は動かし始めた範囲 */
export function moveRect(start: CropRect, dx: number, dy: number, img: ImageSize): CropRect {
  return {
    x: clamp(Math.round(start.x + dx), 0, img.width - start.w),
    y: clamp(Math.round(start.y + dy), 0, img.height - start.h),
    w: start.w,
    h: start.h,
  };
}

/** 四隅のハンドル。nw は左上、se は右下 */
export type Corner = 'nw' | 'ne' | 'sw' | 'se';

/**
 * 角のハンドルを、ドラッグの分だけ動かす。対角の角は動かさない（固定）。
 * ratio（幅 / 高さ）があるときは比を保つ。ドラッグが大きいほうの方向に合わせる。
 * start は動かし始めた範囲、dx / dy は動かし始めてからの合計（画素）。
 */
export function resizeRect(
  start: CropRect,
  corner: Corner,
  dx: number,
  dy: number,
  img: ImageSize,
  ratio: number | null,
): CropRect {
  const east = corner[1] === 'e';
  const south = corner[0] === 's';
  // 固定する辺（対角の角）と、動かす辺の位置
  const ax = east ? start.x : start.x + start.w;
  const ay = south ? start.y : start.y + start.h;
  const px = clamp((east ? start.x + start.w : start.x) + dx, 0, img.width);
  const py = clamp((south ? start.y + start.h : start.y) + dy, 0, img.height);
  // 固定の辺から画像の端までの、伸ばせる最大
  const maxW = east ? img.width - ax : ax;
  const maxH = south ? img.height - ay : ay;
  const m = minSize(img);

  let w: number;
  let h: number;
  if (ratio === null) {
    w = clamp(Math.round(Math.abs(px - ax)), m.w, maxW);
    h = clamp(Math.round(Math.abs(py - ay)), m.h, maxH);
  } else {
    const cap = Math.min(maxW, maxH * ratio);
    const lo = Math.max(m.w, m.h * ratio);
    w = Math.floor(clamp(Math.max(Math.abs(px - ax), Math.abs(py - ay) * ratio), lo, cap));
    h = Math.round(w / ratio);
    if (h > maxH) {
      h = maxH;
      w = Math.round(h * ratio);
    }
  }
  return {
    x: east ? ax : ax - w,
    y: south ? ay : ay - h,
    w,
    h,
  };
}

/** 画像を表示の箱に収めたときの大きさと、画素あたりの表示の大きさ（倍率）。小さい画像は拡大しない */
export function fitDisplay(img: ImageSize, box: ImageSize): { width: number; height: number; scale: number } {
  const scale = Math.min(1, box.width / img.width, box.height / img.height);
  return { width: img.width * scale, height: img.height * scale, scale };
}

/** 表示の長さを、元の画像の画素の長さにする */
export function displayToSource(v: number, scale: number): number {
  return v / scale;
}

/** 元の画像の画素の長さを、表示の長さにする */
export function sourceToDisplay(v: number, scale: number): number {
  return v * scale;
}

/** 範囲を表示の座標（倍率をかけたもの）にする */
export function rectToDisplay(r: CropRect, scale: number): CropRect {
  return { x: r.x * scale, y: r.y * scale, w: r.w * scale, h: r.h * scale };
}

// ---- 画像の情報（寸法・透過・アニメーション） ----

/** 切り抜きの前に読んでおく画像の情報 */
export type ImageInfo = ImageSize & {
  /** 透過がある（切り抜いたあとを PNG にする） */
  alpha: boolean;
  /** アニメーション（APNG / アニメーション WebP）。切り抜かない */
  animated: boolean;
};

/** 切り抜きの対象にできるか（情報が読めて、アニメーションでないもの。GIF は読み込みの段階で外す） */
export function canCropImage(info: ImageInfo | null | undefined): info is ImageInfo {
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

/** 切り抜いたあとの形式。透過があれば PNG、なければ JPEG */
export function outputMime(alpha: boolean): 'image/png' | 'image/jpeg' {
  return alpha ? 'image/png' : 'image/jpeg';
}

/** 切り抜いたあとのファイル名（拡張子を形式に合わせる。名前の元の部分は残す） */
export function outputName(name: string, mime: string): string {
  const stem = name.replace(/\.[^.]*$/, '') || 'image';
  return stem + (mime === 'image/png' ? '.png' : '.jpg');
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
 * 画像の寸法・透過・アニメーションを読む。画像でない・GIF・読めないものは null（切り抜きの対象外）。
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
 * 送信のときに、添付するファイルを用意する。crop が null（全体）や、切り抜く必要がなければ元のファイルを返す。
 * 切り抜くときは JPEG（透過があれば PNG）にする。
 */
export async function prepareUpload(file: File, crop: CropRect | null): Promise<File> {
  if (!crop) return file;
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const r = clampRect(crop, bitmap);
    if (isFullRect(r, bitmap)) return file;
    const s = makeSurface(r.w, r.h);
    s.ctx.imageSmoothingEnabled = true;
    s.ctx.imageSmoothingQuality = 'high';
    s.ctx.drawImage(bitmap, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    const alpha =
      (file.type === 'image/png' || file.type === 'image/webp') &&
      anyTransparent(s.ctx.getImageData(0, 0, r.w, r.h).data);
    const mime = outputMime(alpha);
    const blob = await s.encode(mime, 0.9);
    if (!blob) throw new Error('画像を切り抜けませんでした');
    return new File([blob], outputName(file.name, blob.type || mime), {
      type: blob.type || mime,
      lastModified: file.lastModified,
    });
  } finally {
    bitmap.close();
  }
}
