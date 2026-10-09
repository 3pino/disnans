// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUi } from './ui';
import { setLucideForTest } from '../icons.svelte';

const ui = createUi({ toast: vi.fn(), confirm: vi.fn(async () => true) });

beforeEach(() => setLucideForTest({ Puzzle: [['path', { d: 'M1 1' }]] } as never));
afterEach(() => setLucideForTest(null));

describe('disnans.ui', () => {
  it('button: 文字だけ・アイコン+文字・アイコンだけ', () => {
    const onClick = vi.fn();
    const a = ui.button({ text: '保存', variant: 'primary', onClick });
    expect(a.className).toBe('btn primary');
    expect(a.textContent).toBe('保存');
    a.click();
    expect(onClick).toHaveBeenCalledOnce();

    const b = ui.button({ text: '振る', icon: 'puzzle', disabled: true });
    expect(b.firstElementChild?.getAttribute('class')).toBe('icon');
    expect(b.firstElementChild?.getAttribute('width')).toBe('15');
    expect(b.textContent).toBe('振る');
    expect(b.disabled).toBe(true);
    expect(b.classList.contains('btn-icon-only')).toBe(false);

    const c = ui.button({ icon: 'puzzle', label: '送信' });
    expect(c.classList.contains('btn-icon-only')).toBe(true);
    expect(c.getAttribute('aria-label')).toBe('送信');
    expect(c.firstElementChild?.getAttribute('width')).toBe('18');

    expect(() => ui.button({ icon: 'puzzle' } as never)).toThrow();
    expect(() => ui.button({} as never)).toThrow();
  });

  it('icon: .icon の <svg>', () => {
    const el = ui.icon('puzzle', { size: 20, label: 'パズル' });
    expect(el.tagName.toLowerCase()).toBe('svg');
    expect(el.getAttribute('class')).toBe('icon');
    expect(el.getAttribute('aria-label')).toBe('パズル');
    expect(el.innerHTML).toContain('M1 1');
  });

  it('segmented: 選ぶと見た目が切り替わり、onChange を呼ぶ', () => {
    const onChange = vi.fn();
    const el = ui.segmented({
      label: 'テーマ',
      value: 'a',
      options: [
        { value: 'a', label: 'A', icon: 'puzzle' },
        { value: 'b', label: 'B' },
      ],
      onChange,
    });
    const [a, b] = [...el.querySelectorAll('button')];
    expect(el.className).toBe('segmented');
    expect(a.classList.contains('segmented-option-selected')).toBe(true);
    b.click();
    expect(onChange).toHaveBeenCalledWith('b');
    expect(a.getAttribute('aria-checked')).toBe('false');
    expect(b.classList.contains('segmented-option-selected')).toBe(true);
    b.click();
    expect(onChange).toHaveBeenCalledOnce();
  });

  it('navbar: アイコン・ラベル・バッジ', () => {
    const onSelect = vi.fn();
    const el = ui.navbar({
      selected: 'x',
      items: [
        { id: 'x', label: 'X', icon: 'puzzle', badge: 3 },
        { id: 'y', label: 'Y', icon: 'puzzle', badge: 0 },
      ],
      onSelect,
    });
    const [x, y] = [...el.querySelectorAll('.nav-bar-item')] as HTMLButtonElement[];
    expect(x.querySelector('.nav-bar-item-badge')?.textContent).toBe('3');
    expect(y.querySelector('.nav-bar-item-badge')).toBeNull();
    expect(x.getAttribute('aria-current')).toBe('page');
    y.click();
    expect(onSelect).toHaveBeenCalledWith('y');
    expect(x.classList.contains('nav-bar-item-selected')).toBe(false);
    expect(y.classList.contains('nav-bar-item-selected')).toBe(true);
  });

  it('setting: アイコンは名前の左', () => {
    const box = document.createElement('div');
    const row = ui.setting(box, { name: '名前', description: '説明', icon: 'puzzle', control: ui.divider() });
    expect(box.lastElementChild).toBe(row);
    expect([...row.children].map((c) => c.getAttribute('class'))).toEqual([
      'icon setting-row-icon',
      'setting-row-info',
      'setting-row-control',
    ]);
    expect(row.querySelector('hr')?.className).toBe('divider');
  });
});
