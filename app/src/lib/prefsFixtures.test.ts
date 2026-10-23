// 既定値が fixture（crates/client-core/tests/fixtures/prefs/defaults.json）と同じかを確かめる（V5）。
// 読み方（正規化）の fixture（user_prefs.json）は Rust の tests/prefs_fixtures.rs だけが読む。GUI は Rust の正規化を表示に使うため（段 C）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CALL_SETTINGS } from './call/pure';
import { DEFAULT_ORIENTATION } from './orientation';
import { DEVICE_DEFAULTS, userDefaults } from './settingsModel';

const DEFAULTS = fileURLToPath(new URL('../../../crates/client-core/tests/fixtures/prefs/defaults.json', import.meta.url));

describe('fixtures (V5): defaults', () => {
  const d = (JSON.parse(readFileSync(DEFAULTS, 'utf8')) as { defaults: Record<string, unknown> }).defaults;

  it('call settings（ユーザー共通と機器の項目）', () => {
    expect({
      joinMuted: DEFAULT_CALL_SETTINGS.joinMuted,
      micVolume: DEFAULT_CALL_SETTINGS.micVolume,
      outVolume: DEFAULT_CALL_SETTINGS.outVolume,
      limiter: DEFAULT_CALL_SETTINGS.limiter,
      limitDb: DEFAULT_CALL_SETTINGS.limitDb,
      inputId: DEFAULT_CALL_SETTINGS.inputId,
      output: DEFAULT_CALL_SETTINGS.output,
    }).toEqual({
      joinMuted: d.joinMuted,
      micVolume: d.micVolume,
      outVolume: d.outVolume,
      limiter: d.limiter,
      limitDb: d.limitDb,
      inputId: d.inputId,
      output: d.output,
    });
  });

  it('ユーザー共通の既定値（表示の補完に使う）', () => {
    const u = userDefaults();
    for (const [key, value] of Object.entries(u)) expect(value, key).toEqual(d[key]);
  });

  it('デバイスごとの既定値（表示の補完に使う）', () => {
    for (const [key, value] of Object.entries(DEVICE_DEFAULTS)) expect(value, key).toEqual(d[key]);
  });

  it('画面の向きの既定', () => {
    expect(DEFAULT_ORIENTATION).toBe(d.orientation);
  });
});
