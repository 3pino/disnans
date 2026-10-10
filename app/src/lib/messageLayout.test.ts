import { describe, expect, it } from 'vitest';
import { DEFAULT_MESSAGE_LAYOUT, normalizeMessageLayout } from './messageLayout';

describe('normalizeMessageLayout', () => {
  it('既定はリスト（Slack 風）', () => {
    expect(DEFAULT_MESSAGE_LAYOUT).toBe('list');
    expect(normalizeMessageLayout(undefined)).toBe('list');
    expect(normalizeMessageLayout(null)).toBe('list');
  });

  it('保存された値をそのまま読む', () => {
    expect(normalizeMessageLayout('list')).toBe('list');
    expect(normalizeMessageLayout('bubble')).toBe('bubble');
  });

  it('知らない値・型が違う値は既定', () => {
    expect(normalizeMessageLayout('card')).toBe('list');
    expect(normalizeMessageLayout('Bubble')).toBe('list');
    expect(normalizeMessageLayout(1)).toBe('list');
    expect(normalizeMessageLayout({ layout: 'bubble' })).toBe('list');
  });
});
