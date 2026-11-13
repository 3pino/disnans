/**
 * 画面共有の分割フレーム（JS の送り手・受け手の共通）。
 * Android のネイティブ送信（8 KiB）とは別の大きさを、呼び出し側が chunkChars で渡す。
 */
export const CHUNK_CHARS = 40 * 1024;
/** 1 フレームの分割数の上限（受け取る側の検査）。40 KB × 64 = 2.5 MB */
export const MAX_CHUNKS = 64;
/** 1 かけらの payload の上限（文字数）。検査で使う */
const MAX_PAYLOAD_CHARS = 64 * 1024;

export type FrameChunk = { f: number; i: number; n: number; d: string };

/** フレームを、payload に入る大きさに分ける */
export function splitFrame(frameId: number, b64: string, chunkChars: number = CHUNK_CHARS): FrameChunk[] {
  const n = Math.max(1, Math.ceil(b64.length / chunkChars));
  const out: FrameChunk[] = [];
  for (let i = 0; i < n; i++) out.push({ f: frameId, i, n, d: b64.slice(i * chunkChars, (i + 1) * chunkChars) });
  return out;
}

/** 届いた payload が分割フレームの形か調べる（外から来る値なので疑って読む） */
export function parseChunk(p: unknown): FrameChunk | null {
  if (typeof p !== 'object' || p === null) return null;
  const { f, i, n, d } = p as Record<string, unknown>;
  if (!Number.isInteger(f) || !Number.isInteger(i) || !Number.isInteger(n) || typeof d !== 'string') return null;
  const fi = f as number;
  const ii = i as number;
  const nn = n as number;
  if (nn < 1 || nn > MAX_CHUNKS || ii < 0 || ii >= nn || d.length > MAX_PAYLOAD_CHARS) return null;
  return { f: fi, i: ii, n: nn, d };
}

/**
 * 1 人の送り手の分割フレームを組み立てる。欠けたフレームは捨てる:
 * - 新しいフレームの先頭が届いたら、組み立て中の古いものは捨てる
 * - 完成済み・古い番号のかけらは無視する
 */
export class FrameAssembler {
  #current = -1;
  #done = -1;
  #parts: (string | undefined)[] = [];
  #count = 0;
  #total = 0;

  /** かけらを 1 つ渡す。フレームが揃ったら base64 全体を返す */
  push(c: FrameChunk): string | null {
    if (c.f <= this.#done || c.f < this.#current) return null;
    if (c.f > this.#current || c.n !== this.#total) {
      this.#current = c.f;
      this.#total = c.n;
      this.#parts = new Array(c.n);
      this.#count = 0;
    }
    if (this.#parts[c.i] === undefined) {
      this.#parts[c.i] = c.d;
      this.#count++;
    }
    if (this.#count < this.#total) return null;
    const data = this.#parts.join('');
    this.#done = c.f;
    this.#current = -1;
    this.#parts = [];
    this.#count = 0;
    return data;
  }
}

export type ImageMime = 'image/jpeg' | 'image/webp' | 'image/png';

/** base64 の先頭から画像の形式を見分ける。JPEG・WebP・PNG 以外は null（表示しない） */
export function sniffImageMime(b64: string): ImageMime | null {
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  if (b64.startsWith('iVBORw0KGgo')) return 'image/png';
  // RIFF????WEBP（base64 では 'UklGR' で始まり、12 文字目からの 'RUJQ'）
  if (b64.startsWith('UklGR') && b64.slice(12, 16) === 'RUJQ') return 'image/webp';
  return null;
}
