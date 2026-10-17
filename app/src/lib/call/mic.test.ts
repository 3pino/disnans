import { describe, expect, it } from 'vitest';
import { micBackendFlag, rustMicUnavailable } from './mic';

describe('マイクの経路', () => {
  it("Rust の取り込みは Linux かつ 'disnans.rustMic'==='1' のときだけ。それ以外は web", () => {
    expect(micBackendFlag('1', true)).toBe('rust');
    expect(micBackendFlag('1', false)).toBe('web');
    expect(micBackendFlag('0', true)).toBe('web');
    expect(micBackendFlag(null, true)).toBe('web');
  });

  it('未接続の既定は例外（参加を失敗させ、理由を出す）', async () => {
    await expect(rustMicUnavailable(() => {})).rejects.toThrow(/未接続/);
  });
});
