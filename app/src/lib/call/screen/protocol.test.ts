import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHUNK_CHARS, FrameAssembler, MAX_CHUNKS, parseChunk, sniffImageMime, splitFrame } from './protocol';

describe('分割フレーム', () => {
  it('分割して順不同に渡すと元に戻る', () => {
    const b64 = 'ABCDEFGHIJ'.repeat(25);
    const chunks = splitFrame(7, b64, 100);
    expect(chunks).toHaveLength(3);
    expect(chunks.every((c) => c.d.length <= 100 && c.f === 7 && c.n === 3)).toBe(true);
    const a = new FrameAssembler();
    expect(a.push(chunks[2])).toBeNull();
    expect(a.push(chunks[0])).toBeNull();
    expect(a.push(chunks[0])).toBeNull(); // 重複は無視
    expect(a.push(chunks[1])).toBe(b64);
  });

  it('既定の大きさは 40 KiB', () => {
    expect(CHUNK_CHARS).toBe(40 * 1024);
    expect(splitFrame(1, 'x'.repeat(CHUNK_CHARS * 2 + 5))).toHaveLength(3);
  });

  it('Android の golden（8192・合成データ）と一致する', () => {
    const url = new URL('../../../../src-tauri/plugins/screen/android/src/test/resources/screen-relay/golden-v1.json', import.meta.url);
    const golden = JSON.parse(readFileSync(url, 'utf8')) as {
      frameId: number; chunkChars: number; data: string;
      chunks: { f: number; i: number; n: number; from: number; to: number }[];
    };
    const got = splitFrame(golden.frameId, golden.data, golden.chunkChars);
    golden.chunks.forEach((w, k) => expect(got[k]).toEqual({ f: w.f, i: w.i, n: w.n, d: golden.data.slice(w.from, w.to) }));
    const a = new FrameAssembler();
    expect(a.push(got[1])).toBeNull();
    expect(a.push(got[0])).toBe(golden.data);
  });

  it('parseChunk は外から来た値を疑って読む', () => {
    expect(parseChunk({ f: 1, i: 0, n: 1, d: 'AA' })).toEqual({ f: 1, i: 0, n: 1, d: 'AA' });
    expect(parseChunk(null)).toBeNull();
    expect(parseChunk({ f: 1.5, i: 0, n: 1, d: '' })).toBeNull();
    expect(parseChunk({ f: 1, i: 0, n: 0, d: '' })).toBeNull();
    expect(parseChunk({ f: 1, i: 1, n: 1, d: '' })).toBeNull();
    expect(parseChunk({ f: 1, i: 0, n: MAX_CHUNKS + 1, d: '' })).toBeNull();
    expect(parseChunk({ f: 1, i: 0, n: 1, d: 'x'.repeat(64 * 1024 + 1) })).toBeNull();
    expect(parseChunk({ f: 1, i: 0, n: 1, d: 5 })).toBeNull();
  });

  it('欠けたフレームは、新しいフレームが来たら捨てる（完成済みの古い番号も無視）', () => {
    const a = new FrameAssembler();
    const old = splitFrame(1, 'AAAA'.repeat(4), 8);
    const next = splitFrame(2, 'BBBB'.repeat(4), 8);
    expect(a.push(old[0])).toBeNull();
    expect(a.push(next[1])).toBeNull();
    expect(a.push(next[0])).toBe('BBBB'.repeat(4));
    expect(a.push(old[1])).toBeNull();
  });

  it('画像の形式は先頭から読む（JPEG・PNG・WebP 以外は null）', () => {
    expect(sniffImageMime('/9j/AAAA')).toBe('image/jpeg');
    expect(sniffImageMime('iVBORw0KGgoAAA')).toBe('image/png');
    expect(sniffImageMime('UklGRxxxxEBPRUJQ')).toBe('image/webp');
    expect(sniffImageMime('PHN2Zz4=')).toBeNull();
  });
});
