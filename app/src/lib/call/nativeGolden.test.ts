// ネイティブの通話（Kotlin）が照合する固定の値（golden-v1.json）の出どころ。
// この試験は、pure.ts から同じ値を作り直して、保存されたファイルと一致することを確かめる。
// 書き直し: DISNANS_WRITE_GOLDEN=1 でだけ、ファイルを上書きする（pure.ts の式を変えたときの手順）。
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import * as P from './pure';

const GOLDEN = new URL('../../../src-tauri/plugins/notifier/android/src/test/resources/native-call/golden-v1.json', import.meta.url);

/** Kotlin の NativeCallPcmTest が照合する値（生成の道具）。項目の名前は Kotlin 側と合わせてある */
export function buildGolden(): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  const floats = [-1.5, -1, -0.999, -0.5, -0.00001, 0, 0.00001, 0.25, 0.5, 0.999, 1, 1.5];
  out.floatToInt16 = { input: floats, output: Array.from(P.floatToInt16(Float32Array.from(floats))) };
  const ints = [-32768, -32767, -16384, -1, 0, 1, 16383, 32766, 32767];
  out.int16ToFloat = { input: ints, output: Array.from(P.int16ToFloat(Int16Array.from(ints))) };

  const pcm = Int16Array.from({ length: 800 }, (_, i) => Math.round(Math.sin(i / 7) * 12000) - (i % 97));
  const b64 = P.pcmToBase64(pcm);
  const cases = [
    { input: b64, ok: true },
    { input: '', ok: false },
    { input: 'AAE', ok: false },
    { input: 'AA==', ok: true, samples: [0] },
    { input: 'AA', ok: false },
    { input: '!!!!', ok: false },
    { input: 'AAAA'.repeat(2049), ok: false },
  ];
  out.base64 = {
    samples: Array.from(pcm),
    base64: b64,
    base64Length: b64.length,
    decodeCases: cases.map((c) => {
      const r = P.base64ToPcm(c.input);
      return {
        input: c.input.length > 40 ? `len:${c.input.length}` : c.input,
        rawInput: c.input,
        jsOk: r !== null,
        jsSamples: r ? Array.from(r) : null,
      };
    }),
  };

  const rmsIn = Float32Array.from([0, 0.1, -0.2, 0.3, -0.004, 0.5]);
  out.rms = { input: Array.from(rmsIn), output: P.rms(rmsIn) };

  const sig = Float32Array.from({ length: 2400 }, (_, i) => 0.9 * Math.sin(i * 0.05) + (i % 333 === 0 ? 1.4 : 0));
  const limiterCases = [-18, -12, -6, -3].map((db) => {
    const lim = new P.PeakLimiter(P.RELAY_RATE, db);
    const chunks: number[][] = [];
    for (let off = 0; off < sig.length; off += 800) chunks.push(Array.from(lim.process(sig.slice(off, off + 800))));
    return { db, chunks };
  });
  out.limiter = { chunkSize: 800, input: Array.from(sig), cases: limiterCases };

  const trace: { now: number; dur: number; at: number | null }[] = [];
  const st = { next: 0 };
  const steps: [number, number][] = [
    [0.0, 0.05], [0.0, 0.05], [0.01, 0.05], [0.02, 0.05], [0.03, 0.05], [0.9, 0.05], [0.91, 0.05],
    ...Array.from({ length: 18 }, (): [number, number] => [1.5, 0.05]),
  ];
  for (const [now, dur] of steps) trace.push({ now, dur, at: P.scheduleFrame(st, now, dur) });
  out.schedule = { defaults: { lead: P.RELAY_LEAD, maxLead: P.RELAY_MAX_LEAD }, trace };

  out.constants = {
    RELAY_RATE: P.RELAY_RATE,
    RELAY_FRAME: P.RELAY_FRAME,
    RELAY_LEAD: P.RELAY_LEAD,
    RELAY_MAX_LEAD: P.RELAY_MAX_LEAD,
    RELAY_HOLD_MS: P.RELAY_HOLD_MS,
    RELAY_SILENCE: P.RELAY_SILENCE,
    LIMIT_LOOKAHEAD_MS: P.LIMIT_LOOKAHEAD_MS,
    LIMIT_ATTACK_MS: P.LIMIT_ATTACK_MS,
    LIMIT_RELEASE_MS: P.LIMIT_RELEASE_MS,
    LIMIT_DB_DEFAULT: P.LIMIT_DB_DEFAULT,
    LIMIT_DB_MIN: P.LIMIT_DB_MIN,
    LIMIT_DB_MAX: P.LIMIT_DB_MAX,
  };
  return out;
}

describe('native call golden vectors（pure.ts と Kotlin の照合の根拠）', () => {
  it('pure.ts から作った値が、保存された golden-v1.json と一致する', () => {
    const stored = JSON.parse(readFileSync(GOLDEN, 'utf8')) as unknown;
    expect(buildGolden()).toEqual(stored);
  });

  it.skipIf(process.env.DISNANS_WRITE_GOLDEN !== '1')('DISNANS_WRITE_GOLDEN=1 のときだけ、golden-v1.json を書き直す', () => {
    writeFileSync(GOLDEN, JSON.stringify(buildGolden()));
  });
});
