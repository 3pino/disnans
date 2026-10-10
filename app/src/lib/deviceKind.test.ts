// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { guessDeviceKind, normalizeDeviceKind } from './deviceKind.svelte';

describe('normalizeDeviceKind', () => {
  it('知っている種類だけ通す', () => {
    expect(normalizeDeviceKind('smartphone')).toBe('smartphone');
    expect(normalizeDeviceKind('tablet')).toBe('tablet');
    expect(normalizeDeviceKind('laptop')).toBe('laptop');
    expect(normalizeDeviceKind('monitor')).toBe('monitor');
    expect(normalizeDeviceKind('toaster')).toBeNull();
    expect(normalizeDeviceKind('Laptop')).toBeNull();
    expect(normalizeDeviceKind(null)).toBeNull();
    expect(normalizeDeviceKind(1)).toBeNull();
  });
});

describe('guessDeviceKind', () => {
  it('Android はスマートフォン、それ以外はノート PC', () => {
    expect(guessDeviceKind('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36')).toBe('smartphone');
    expect(guessDeviceKind('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36')).toBe('laptop');
    expect(guessDeviceKind('')).toBe('laptop');
  });
});
