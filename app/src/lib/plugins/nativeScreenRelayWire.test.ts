import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PluginBase } from './runtime';
import { createUi } from './ui';
import { API_VERSION } from './types';
import { PluginError, VersionConflictError } from './errors';

/**
 * Android の送り手（RelayWire.chunkJson）と、JS の受け手（splitFrame / parseChunk / FrameAssembler）が、
 * 同じ golden（合成の base64 だけ）で噛み合うか。Kotlin 側は ShareRelayWireGoldenTest.kt が同じファイルを読む。
 */
type Golden = {
  version: number;
  frameId: number;
  chunkChars: number;
  data: string;
  chunks: { f: number; i: number; n: number; from: number; to: number }[];
};

const GOLDEN_URL = new URL(
  '../../../src-tauri/plugins/screen/android/src/test/resources/screen-relay/golden-v1.json',
  import.meta.url,
);
const golden = JSON.parse(readFileSync(GOLDEN_URL, 'utf8')) as Golden;

// main.js は読み込み時に disnans.Plugin と ui を覚える（screenshare.test.ts と同じ最小の形）
(globalThis as unknown as { disnans: unknown }).disnans = {
  apiVersion: API_VERSION,
  Plugin: PluginBase,
  ui: createUi({
    toast: () => {},
    confirm: async () => true,
    onBack: () => () => {},
    setImmersive: async () => false,
  }),
  PluginError,
  VersionConflictError,
};

const load = () => import('../../../../examples/screenshare/main.js');

describe('Android の送り手と JS の受け手（golden v1）', () => {
  it('golden は合成データで、版と分割の大きさが想定どおり', () => {
    expect(golden.version).toBe(1);
    expect(golden.chunkChars).toBe(8192);
    expect(golden.data.length).toBe(8200);
    expect(golden.data).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(golden.chunks.map((c) => c.to - c.from)).toEqual([8192, 8]);
  });

  it('splitFrame（明示の 8192）が golden の各かけらと一致する', async () => {
    const { splitFrame } = await load();
    const got = splitFrame(golden.frameId, golden.data, golden.chunkChars);
    expect(got).toHaveLength(golden.chunks.length);
    golden.chunks.forEach((w, k) => {
      expect(got[k]).toEqual({ f: w.f, i: w.i, n: w.n, d: golden.data.slice(w.from, w.to) });
    });
  });

  it('parseChunk は golden の各 JSON 形を受け入れ、同じ中身を返す', async () => {
    const { parseChunk } = await load();
    for (const w of golden.chunks) {
      const payload = JSON.parse(JSON.stringify({ f: w.f, i: w.i, n: w.n, d: golden.data.slice(w.from, w.to) }));
      expect(parseChunk(payload)).toEqual({ f: w.f, i: w.i, n: w.n, d: golden.data.slice(w.from, w.to) });
    }
  });

  it('golden のかけらを順不同で渡すと、元の base64 に戻る', async () => {
    const { splitFrame, FrameAssembler } = await load();
    const chunks = splitFrame(golden.frameId, golden.data, golden.chunkChars);
    const a = new FrameAssembler();
    expect(a.push(chunks[1])).toBeNull();
    expect(a.push(chunks[0])).toBe(golden.data);
  });
});
