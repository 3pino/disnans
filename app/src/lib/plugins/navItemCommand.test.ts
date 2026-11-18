// ui.navItem は、ナビの項目をコマンドとして登録する（自動では出さない。パレットに出る。利用者がナビバーの設定で追加できる）
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandList } from '../commands.svelte';
import { registerNavItemCommand } from './navItemCommand';

const offs: Array<() => void> = [];
afterEach(() => {
  for (const o of offs.splice(0)) o();
});
const reg = (...a: Parameters<typeof registerNavItemCommand>) => {
  const h = registerNavItemCommand(...a);
  return h;
};

describe('ui.navItem はコマンドとして登録する', () => {
  it('登録するとコマンドになる（パレット・ナビバーの設定の一覧に出る）。ナビへの自動追加はしない', () => {
    const h = reg({ id: 'dice:roll', label: 'サイコロ', icon: 'dice' }, vi.fn());
    offs.push(() => h.close());
    const c = commandList().find((x) => x.id === 'plugin-nav:dice:roll');
    expect(c?.name).toBe('サイコロ');
  });

  it('選ぶと view を開く（openView に view の種類が渡る）。onOpen も呼ばれる', () => {
    const openView = vi.fn();
    const onOpen = vi.fn();
    const h = reg({ id: 'x:a', label: 'A', icon: 'a', view: 'v1', onOpen }, openView);
    offs.push(() => h.close());
    commandList().find((x) => x.id === 'plugin-nav:x:a')!.run({ args: '', via: 'palette' } as never);
    expect(openView).toHaveBeenCalledWith('v1');
    expect(onOpen).toHaveBeenCalled();
  });

  it('同じ id は二重に登録できない（invalid_argument）', () => {
    const h = reg({ id: 'y:b', label: 'B', icon: 'b', onOpen: () => {} }, vi.fn());
    offs.push(() => h.close());
    expect(() => reg({ id: 'y:b', label: 'B', icon: 'b', onOpen: () => {} }, vi.fn())).toThrow(expect.objectContaining({ code: 'invalid_argument' }) as never);
  });

  it('close で外れる（コマンドの一覧から消える）', () => {
    const h = reg({ id: 'z:c', label: 'C', icon: 'c', onOpen: () => {} }, vi.fn());
    expect(commandList().some((x) => x.id === 'plugin-nav:z:c')).toBe(true);
    h.close();
    expect(commandList().some((x) => x.id === 'plugin-nav:z:c')).toBe(false);
  });

  it('コアの「ファイル」（fixplor:files）は、コマンドを作らない（入口は「共有フォルダを開く」だけ）', () => {
    const h = reg({ id: 'fixplor:files', label: 'ファイル', icon: 'folder', view: 'fixplor' }, vi.fn());
    expect(commandList().some((x) => x.id === 'plugin-nav:fixplor:files')).toBe(false);
    expect(() => h.setBadge(3)).not.toThrow();
  });

  it('badge は未対応（setBadge は何もしない）', () => {
    const h = reg({ id: 'w:d', label: 'D', icon: 'd', onOpen: () => {} }, vi.fn());
    offs.push(() => h.close());
    expect(() => h.setBadge(5)).not.toThrow();
  });
});
