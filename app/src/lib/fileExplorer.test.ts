import { describe, expect, it } from 'vitest';
import type { SharedEntry } from './protocol/SharedEntry';
import { breadcrumbs, entryAction, kindLabel, sortEntries } from './fileExplorer';

const e = (name: string, kind: 'file' | 'dir' = 'file', mime: string | null = null, size = 0, modified = 0): SharedEntry => ({
  name,
  path: name,
  kind,
  size,
  modified,
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

describe('sortEntries（並べ方と向き）', () => {
  const list = () => [e('b.txt', 'file', null, 20, 300), e('a.txt', 'file', null, 5, 100), e('zdir', 'dir', null, 0, 200), e('c.txt', 'file', null, 20, 200)];
  it('更新日時・サイズは、向きに従う（フォルダは先のまま）', () => {
    expect(sortEntries(list(), 'modified', 'asc').map((x) => x.name)).toEqual(['zdir', 'a.txt', 'c.txt', 'b.txt']);
    expect(sortEntries(list(), 'modified', 'desc').map((x) => x.name)).toEqual(['zdir', 'b.txt', 'c.txt', 'a.txt']);
    expect(sortEntries(list(), 'size', 'desc').map((x) => x.name)).toEqual(['zdir', 'b.txt', 'c.txt', 'a.txt']);
  });
  it('同じ値のものは名前の順（向きを逆にしても、名前は同じ順）', () => {
    expect(sortEntries(list(), 'size', 'asc').map((x) => x.name)).toEqual(['zdir', 'a.txt', 'b.txt', 'c.txt']);
  });
  it('名前の降順は、フォルダを先に、名前を逆に', () => {
    expect(sortEntries(list(), 'name', 'desc').map((x) => x.name)).toEqual(['zdir', 'c.txt', 'b.txt', 'a.txt']);
  });
});

describe('kindLabel（一覧の「種類」）', () => {
  it('フォルダ・画像・拡張子・ファイル', () => {
    expect(kindLabel(e('d', 'dir'))).toBe('フォルダ');
    expect(kindLabel(e('a.png'))).toBe('画像');
    expect(kindLabel(e('x', 'file', 'image/jpeg'))).toBe('画像');
    expect(kindLabel(e('report.pdf'))).toBe('PDF');
    expect(kindLabel(e('README'))).toBe('ファイル');
    expect(kindLabel(e('.env'))).toBe('ファイル');
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
