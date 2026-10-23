import { describe, expect, it } from 'vitest';
import type { SharedEntry } from './protocol/SharedEntry';
import { breadcrumbs, entryAction, sortEntries } from './fileExplorer';

const e = (name: string, kind: 'file' | 'dir' = 'file', mime: string | null = null): SharedEntry => ({
  name,
  path: name,
  kind,
  size: 0,
  modified: 0,
  mime,
  message_id: null,
  file_id: null,
});

describe('sortEntries', () => {
  it('フォルダが先、名前は大文字小文字・数字の桁を区別せずに並べる', () => {
    const names = sortEntries([e('b.txt'), e('a10.txt'), e('A2.txt'), e('zdir', 'dir'), e('adir', 'dir')]).map((x) => x.name);
    expect(names).toEqual(['adir', 'zdir', 'A2.txt', 'a10.txt', 'b.txt']);
  });
});

describe('breadcrumbs', () => {
  it('直下は空', () => expect(breadcrumbs('')).toEqual([]));
  it('階層ごとのパス', () => {
    expect(breadcrumbs('docs/a/b')).toEqual([
      { name: 'docs', path: 'docs' },
      { name: 'a', path: 'docs/a' },
      { name: 'b', path: 'docs/a/b' },
    ]);
  });
});

describe('entryAction', () => {
  it('フォルダは中へ、画像は拡大、ほかはファイル', () => {
    expect(entryAction(e('d', 'dir'))).toBe('enter');
    expect(entryAction(e('a.PNG'))).toBe('image');
    expect(entryAction(e('x', 'file', 'image/jpeg'))).toBe('image');
    expect(entryAction(e('a.pdf'))).toBe('file');
  });
});
