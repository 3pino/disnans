import { beforeEach, describe, expect, it } from 'vitest';
import { explorerSelection } from './explorerSelection.svelte';

beforeEach(() => explorerSelection.clear());

describe('一覧の複数選択', () => {
  it('長押し（start）で選択モードに入り、その項目を選ぶ', () => {
    explorerSelection.start('a.txt');
    expect(explorerSelection.active).toBe(true);
    expect(explorerSelection.paths()).toEqual(['a.txt']);
  });

  it('選択モードの中では、押すたびに選ぶ・選ばないを切り替える', () => {
    explorerSelection.start('a.txt');
    explorerSelection.toggle('b.txt');
    expect(explorerSelection.count).toBe(2);
    explorerSelection.toggle('a.txt');
    expect(explorerSelection.has('a.txt')).toBe(false);
    expect(explorerSelection.active).toBe(true);
  });

  it('すべて選ぶ・選択を終える', () => {
    explorerSelection.selectAll(['a', 'b', 'c']);
    expect(explorerSelection.count).toBe(3);
    explorerSelection.clear();
    expect(explorerSelection.active).toBe(false);
    expect(explorerSelection.count).toBe(0);
  });
});
