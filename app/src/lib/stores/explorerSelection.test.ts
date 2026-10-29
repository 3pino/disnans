import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  it('最後の 1 件を外して 0 件になったら、選択モードを終える', () => {
    explorerSelection.start('a.txt');
    explorerSelection.toggle('a.txt');
    expect(explorerSelection.active).toBe(false);
  });

  it('すべて選ぶ・選択を終える', () => {
    explorerSelection.selectAll(['a', 'b', 'c']);
    expect(explorerSelection.count).toBe(3);
    explorerSelection.clear();
    expect(explorerSelection.active).toBe(false);
    expect(explorerSelection.count).toBe(0);
  });
});

describe('PC の選択（0 件でも操作が続く）', () => {
  beforeEach(() => {
    explorerSelection.clear();
    explorerSelection.desktop = true;
  });
  afterEach(() => {
    explorerSelection.desktop = false;
  });

  it('0→1→0→1 で、0 件になっても効いたまま。1 件以上のときだけ印を出す', () => {
    expect(explorerSelection.active).toBe(true);
    expect(explorerSelection.showing).toBe(false);
    explorerSelection.toggle('a.txt');
    expect(explorerSelection.showing).toBe(true);
    explorerSelection.toggle('a.txt');
    expect(explorerSelection.count).toBe(0);
    expect(explorerSelection.active).toBe(true);
    expect(explorerSelection.showing).toBe(false);
    explorerSelection.toggle('a.txt');
    expect(explorerSelection.has('a.txt')).toBe(true);
    expect(explorerSelection.showing).toBe(true);
  });

  it('空きスペース・フォルダ移動（clear）で選びは外れるが、効いたまま', () => {
    explorerSelection.toggle('a.txt');
    explorerSelection.clear();
    expect(explorerSelection.count).toBe(0);
    expect(explorerSelection.active).toBe(true);
    expect(explorerSelection.showing).toBe(false);
  });

  it('すべて選ぶ・長押し（start）でも、外して 0 件になっても効いたまま', () => {
    explorerSelection.selectAll(['a', 'b']);
    expect(explorerSelection.showing).toBe(true);
    explorerSelection.toggle('a');
    explorerSelection.toggle('b');
    expect(explorerSelection.active).toBe(true);
    expect(explorerSelection.showing).toBe(false);
  });
});

describe('タッチの選択は、0 件で終わる（従来どおり）', () => {
  beforeEach(() => {
    explorerSelection.clear();
    explorerSelection.desktop = false;
  });

  it('効いているのは選択モードの間だけ。0 件になると終わり、印も出ない', () => {
    expect(explorerSelection.active).toBe(false);
    explorerSelection.start('a.txt');
    expect(explorerSelection.active).toBe(true);
    expect(explorerSelection.showing).toBe(true);
    explorerSelection.toggle('a.txt');
    expect(explorerSelection.active).toBe(false);
    expect(explorerSelection.showing).toBe(false);
  });

  it('enter() は効かせるが、印は 1 件以上選んでから', () => {
    explorerSelection.enter();
    expect(explorerSelection.active).toBe(true);
    expect(explorerSelection.showing).toBe(true);
    explorerSelection.clear();
    expect(explorerSelection.active).toBe(false);
  });
});
