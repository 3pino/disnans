import { describe, expect, it } from 'vitest';
import { shareInbox } from './shareInbox.svelte';

describe('shareInbox', () => {
  it('keeps pushed files and text until taken, then empties', () => {
    const a = new File(['a'], 'a.txt');
    const b = new File(['b'], 'b.txt');
    shareInbox.push([a], 'こんにちは');
    shareInbox.push([b], '本文');
    const got = shareInbox.take();
    expect(got.files.map((f) => f.name)).toEqual(['a.txt', 'b.txt']);
    expect(got.text).toBe('こんにちは\n本文');
    expect(shareInbox.take()).toEqual({ files: [], text: '' });
  });
});
