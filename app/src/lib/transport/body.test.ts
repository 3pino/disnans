import { describe, expect, it } from 'vitest';
import { bytesToBase64, encodeBody } from './body';

describe('body encoding (Android sends base64, desktop raw)', () => {
  it('encodes bytes to base64 like the standard codec, including chunk boundaries', () => {
    const big = new Uint8Array(0x8000 * 2 + 5).map((_, i) => (i * 31) & 0xff);
    const expected = Buffer.from(big).toString('base64');
    expect(bytesToBase64(big)).toBe(expected);
    expect(bytesToBase64(new Uint8Array([0, 255, 1]))).toBe('AP8B');
    expect(bytesToBase64(new Uint8Array())).toBe('');
  });

  it('raw keeps the bytes; base64 turns them into a JSON string', () => {
    const u8 = new Uint8Array([1, 2, 3]);
    expect(encodeBody(u8, 'raw')).toBe(u8);
    expect(encodeBody(u8, 'base64')).toBe('AQID');
  });
});
