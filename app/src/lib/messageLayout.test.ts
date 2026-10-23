import { describe, expect, it } from 'vitest';
import { DEFAULT_MESSAGE_LAYOUT } from './messageLayout';

// 吹き出しは撤去。保存された旧い値（'bubble'）は prefs の側で見ない（一覧に固定）
describe('messageLayout', () => {
  it('既定はリスト（Slack 風）', () => {
    expect(DEFAULT_MESSAGE_LAYOUT).toBe('list');
  });
});
