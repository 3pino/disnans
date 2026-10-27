import { loadPdfjs } from './pdfjs';

// PDF の 1 ページ目の縮小画像（共有フォルダのアイコン表示のサムネイル）。
// pdf.js（lib/pdfjs.ts）は、PDF のサムネイルを初めて作るときだけ読み込む。
// サーバーは Range に答えるので、大きな PDF でも 1 ページ目に要る分だけ読む。作った画像は object URL で覚えておく

/** これより大きい PDF はサムネイルを作らない（Range が効かない環境で全部を読まないように） */
export const PDF_THUMB_MAX_BYTES = 50 * 1024 * 1024;
/** 同時に作る数（一覧を開いた直後にまとめて読み込まないように） */
const PARALLEL = 2;
/** 覚えておく数（古いものから捨て、object URL を解放する） */
const CACHE_MAX = 200;

const cache = new Map<string, Promise<string | null>>();
let running = 0;
const waiting: (() => void)[] = [];

/**
 * PDF の 1 ページ目を、長い辺が px の画像にする（object URL）。作れなければ null。
 * key が同じなら作り直さない（パスと更新日時を入れる）
 */
export function pdfThumb(url: string, key: string, px: number): Promise<string | null> {
  const k = `${key}@${px}`;
  const hit = cache.get(k);
  if (hit) return hit;
  const made = limited(() => render(url, px)).catch(() => null);
  cache.set(k, made);
  if (cache.size > CACHE_MAX) {
    const [oldKey, old] = cache.entries().next().value!;
    cache.delete(oldKey);
    void old.then((u) => u && URL.revokeObjectURL(u));
  }
  return made;
}

async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= PARALLEL) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

async function render(url: string, px: number): Promise<string | null> {
  const pdfjs = await loadPdfjs();
  // 1 ページ目に要る分だけ読む（先読み・流し読みはしない）。PDF の中のスクリプトは評価しない
  const task = pdfjs.getDocument({ url, isEvalSupported: false, disableAutoFetch: true, disableStream: true });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: px / Math.max(base.width, base.height) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    // 透明のページ（背景なし）も紙に見えるよう、白で塗ってから描く
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const toBlob = (type: string) => new Promise<Blob | null>((r) => canvas.toBlob(r, type, 0.85));
    const blob = (await toBlob('image/webp')) ?? (await toBlob('image/png'));
    return blob ? URL.createObjectURL(blob) : null;
  } finally {
    await task.destroy();
  }
}
