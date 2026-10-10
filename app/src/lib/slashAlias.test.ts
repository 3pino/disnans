import { describe, expect, it } from 'vitest';
import { checkSlashAlias, normalizeSlashAliases, setSlashAlias } from './slashAlias';

describe('normalizeSlashAliases', () => {
  it('正しい名前の文字列だけを残す', () => {
    expect(normalizeSlashAliases({ 'dice:roll': 'roll2', 'app:x': 'Bad Name', 'app:y': '', 'app:z': 3, 'app:w': 'ok-1' })).toEqual({
      'dice:roll': 'roll2',
      'app:w': 'ok-1',
    });
    expect(normalizeSlashAliases(null)).toEqual({});
    expect(normalizeSlashAliases(['a'])).toEqual({});
  });
});

describe('setSlashAlias', () => {
  it('付ける・消す。ほかのコマンドの別名は変えない', () => {
    const a = { 'x:a': 'aa', 'x:b': 'bb' };
    expect(setSlashAlias(a, 'x:a', 'cc')).toEqual({ 'x:a': 'cc', 'x:b': 'bb' });
    expect(setSlashAlias(a, 'x:a', null)).toEqual({ 'x:b': 'bb' });
    // 元の配列は変えない
    expect(a).toEqual({ 'x:a': 'aa', 'x:b': 'bb' });
  });
});

describe('checkSlashAlias', () => {
  const taken = ['dice', 'settings'];

  it('空・不正な文字・重複は弾く', () => {
    expect(checkSlashAlias('', { original: 'dice', taken })).toMatchObject({ ok: false });
    expect(checkSlashAlias('   ', { original: 'dice', taken })).toMatchObject({ ok: false });
    expect(checkSlashAlias('Roll', { original: 'dice', taken })).toMatchObject({ ok: false });
    expect(checkSlashAlias('a b', { original: 'dice', taken })).toMatchObject({ ok: false });
    expect(checkSlashAlias('/roll', { original: 'dice', taken })).toMatchObject({ ok: false });
    expect(checkSlashAlias('-roll', { original: 'dice', taken })).toMatchObject({ ok: false });
    expect(checkSlashAlias('ロール', { original: 'dice', taken })).toMatchObject({ ok: false });
    expect(checkSlashAlias('a'.repeat(33), { original: 'dice', taken })).toMatchObject({ ok: false });
    expect(checkSlashAlias('settings', { original: 'dice', taken })).toMatchObject({ ok: false });
  });

  it('正しい名前は別名になる（前後の空白は除く）。元の名前と同じなら別名なし（null）', () => {
    expect(checkSlashAlias(' roll ', { original: 'dice', taken })).toEqual({ ok: true, alias: 'roll' });
    expect(checkSlashAlias('a'.repeat(32), { original: 'dice', taken })).toEqual({ ok: true, alias: 'a'.repeat(32) });
    expect(checkSlashAlias('dice', { original: 'dice', taken: ['settings'] })).toEqual({ ok: true, alias: null });
    expect(checkSlashAlias('2d6', { taken })).toEqual({ ok: true, alias: '2d6' });
  });
});
