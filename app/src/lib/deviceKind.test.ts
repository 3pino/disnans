// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { guessDeviceKind } from './deviceKind.svelte';

describe('guessDeviceKind', () => {
  it('Android はスマートフォン、それ以外はノート PC', () => {
    expect(guessDeviceKind('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36')).toBe('smartphone');
    expect(guessDeviceKind('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36')).toBe('laptop');
    expect(guessDeviceKind('')).toBe('laptop');
  });
});
