import { describe, expect, it } from 'vitest';
import { DEFAULT_MESSAGE_LAYOUT } from './messageLayout';

// 値の読み方（知らない値は既定）は Rust の正規化（tests/fixtures/prefs/user_prefs.json）が見る
describe('messageLayout', () => {
  it('既定はリスト（Slack 風）', () => {
    expect(DEFAULT_MESSAGE_LAYOUT).toBe('list');
  });
});
