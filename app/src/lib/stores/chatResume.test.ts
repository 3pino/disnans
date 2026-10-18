import { describe, expect, it } from 'vitest';
import { RESUME_STALE_MS, resumeReconnect } from './chatResume';

describe('resumeReconnect（Android の復帰で作り直すか）', () => {
  it('作り直す: まだ始まっていない・切れている', () => {
    expect(resumeReconnect({ hiddenMs: 0, started: false, down: false })).toBe(true);
    expect(resumeReconnect({ hiddenMs: 0, started: true, down: true })).toBe(true);
  });

  it('作り直さない: 接続があり、背景が短い', () => {
    expect(resumeReconnect({ hiddenMs: 0, started: true, down: false })).toBe(false);
    expect(resumeReconnect({ hiddenMs: RESUME_STALE_MS - 1, started: true, down: false })).toBe(false);
  });

  it('作り直す: 接続があっても、背景が長かった（しきい値ちょうどを含む）', () => {
    expect(resumeReconnect({ hiddenMs: RESUME_STALE_MS, started: true, down: false })).toBe(true);
    expect(resumeReconnect({ hiddenMs: 10 * 60_000, started: true, down: false })).toBe(true);
  });
});
