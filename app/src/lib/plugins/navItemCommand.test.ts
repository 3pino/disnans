// ui.navItem は、ナビの項目をコマンドとして登録する（自動では出さない。パレットに出る。利用者がナビバーの設定で追加できる）。
// view を持つ項目は、その view を開いている間ナビで選ばれる（viewCommandOf）。コアの「ファイル」も、ほかのプラグインと同じ扱い。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandList } from '../commands.svelte';
import { registerNavItemCommand, viewCommandOf } from './navItemCommand';

const handles: Array<{ close(): void }> = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
const reg = (...a: Parameters<typeof registerNavItemCommand>) => {
  const h = registerNavItemCommand(...a);
  handles.push(h);
  return h;
};
const cmd = (id: string) => commandList().find((x) => x.id === id);

describe('ui.navItem はコマンドとして登録する', () => {
  it('登録するとコマンドになる（パレット・ナビバーの設定の一覧に出る）。ナビへの自動追加はしない', () => {
    reg({ id: 'dice:roll', label: 'サイコロ', icon: 'dice' }, vi.fn());
    expect(cmd('plugin-nav:dice:roll')?.name).toBe('サイコロ');
  });

  it('選ぶと view を開く（openView に view の種類が渡る）。onOpen も呼ばれる', () => {
    const openView = vi.fn();
    const onOpen = vi.fn();
    reg({ id: 'x:a', label: 'A', icon: 'a', view: 'v1', onOpen }, openView);
    cmd('plugin-nav:x:a')!.run({ args: '', via: 'palette' } as never);
    expect(openView).toHaveBeenCalledWith('v1');
    expect(onOpen).toHaveBeenCalled();
  });

  it('同じ id は二重に登録できない（invalid_argument）', () => {
    reg({ id: 'y:b', label: 'B', icon: 'b', onOpen: () => {} }, vi.fn());
    expect(() => reg({ id: 'y:b', label: 'B', icon: 'b', onOpen: () => {} }, vi.fn())).toThrow(expect.objectContaining({ code: 'invalid_argument' }) as never);
  });

  it('close で外れる（コマンドの一覧から消える）', () => {
    const h = reg({ id: 'z:c', label: 'C', icon: 'c', onOpen: () => {} }, vi.fn());
    expect(cmd('plugin-nav:z:c')).toBeDefined();
    h.close();
    expect(cmd('plugin-nav:z:c')).toBeUndefined();
  });

  it('コアの「ファイル」（fixplor:files）も、ほかのプラグインと同じくコマンドになる（特別扱いなし）', () => {
    reg({ id: 'fixplor:files', label: 'ファイル', icon: 'folder', view: 'fixplor' }, vi.fn());
    expect(cmd('plugin-nav:fixplor:files')?.name).toBe('ファイル');
  });

  it('badge は未対応（setBadge は何もしない）', () => {
    const h = reg({ id: 'w:d', label: 'D', icon: 'd', onOpen: () => {} }, vi.fn());
    expect(() => h.setBadge(5)).not.toThrow();
  });
});

describe('view とナビの項目の対応（開いている view の項目が選ばれる）', () => {
  it('view を渡した項目は、その view の種類からコマンドを引ける。close で外れる', () => {
    const h = reg({ id: 'v:one', label: 'V', icon: 'v', view: 'view-one' }, vi.fn());
    expect(viewCommandOf('view-one')).toBe('plugin-nav:v:one');
    h.close();
    expect(viewCommandOf('view-one')).toBeNull();
  });

  it('view を渡さない項目（onOpen だけ）は、view の対応を作らない', () => {
    reg({ id: 'v:two', label: 'V2', icon: 'v', onOpen: () => {} }, vi.fn());
    expect(viewCommandOf('v:two')).toBeNull();
  });

  it('対応のない view は null', () => {
    expect(viewCommandOf('nothing')).toBeNull();
  });
});
