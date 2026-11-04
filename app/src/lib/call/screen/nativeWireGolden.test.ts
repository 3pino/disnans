import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FrameAssembler, parseChunk, splitFrame } from './protocol';

/** 実際の本体の組み立てと Kotlin の分割が共有する、合成データだけの golden。 */
type Golden = {
  version: number; frameId: number; chunkChars: number; data: string;
  chunks: { f: number; i: number; n: number; from: number; to: number }[];
};
const golden = JSON.parse(readFileSync(new URL('../../../../src-tauri/plugins/screen/android/src/test/resources/screen-relay/golden-v1.json', import.meta.url), 'utf8')) as Golden;

describe('本体の画面共有と Android の送り手（golden v1）', () => {
  it('合成データの境界と版を確認する', () => {
    expect(golden.version).toBe(1);
    expect(golden.chunkChars).toBe(8192);
    expect(golden.data.length).toBe(8200);
    expect(golden.data).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(golden.chunks.map((c) => c.to - c.from)).toEqual([8192, 8]);
  });
  it('本体の分割の各 payload が一致する', () => {
    const chunks = splitFrame(golden.frameId, golden.data, golden.chunkChars);
    expect(chunks).toHaveLength(golden.chunks.length);
    golden.chunks.forEach((w, k) => expect(chunks[k]).toEqual({ f: w.f, i: w.i, n: w.n, d: golden.data.slice(w.from, w.to) }));
  });
  it('各 JSON を受け入れる', () => {
    for (const w of golden.chunks) {
      const p = { f: w.f, i: w.i, n: w.n, d: golden.data.slice(w.from, w.to) };
      expect(parseChunk(JSON.parse(JSON.stringify(p)))).toEqual(p);
    }
  });
  it('順不同でも本体の組み立てで元に戻る', () => {
    const chunks = splitFrame(golden.frameId, golden.data, golden.chunkChars);
    const a = new FrameAssembler();
    expect(a.push(chunks[1])).toBeNull();
    expect(a.push(chunks[0])).toBe(golden.data);
  });
});
