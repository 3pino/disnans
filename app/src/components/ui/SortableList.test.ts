// @vitest-environment jsdom
// 並べ替えの部品の DOM のテスト（キーボード・ポインターの取り消し・並びの変化・文脈メニュー）。
// ポインターの座標は jsdom では本物の描画の位置を持たないため、判定は lib/sortable.test.ts の純関数で確かめ、ここでは配線を見る。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import Host from './SortableListTestHost.svelte';

type HostExports = { setItems: (items: { id: string; name: string }[]) => void };

const ITEMS = [
  { id: 'a', name: 'A' },
  { id: 'b', name: 'B' },
  { id: 'c', name: 'C' },
];

let instance: ReturnType<typeof mount> | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (instance) void unmount(instance);
  host?.remove();
  instance = null;
  host = null;
});

function render(onmove = vi.fn(), options: { onremove?: (id: string) => void; removable?: (item: { id: string; name: string }) => boolean } = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  instance = mount(Host, { target: host, props: { onmove, ...options } });
  flushSync();
  return { onmove, exports: instance as unknown as HostExports, host };
}

function bodyOf(id: string): HTMLElement {
  const el = host!.querySelector<HTMLElement>(`[data-sortable-id="${id}"] .sortable-list-body`);
  if (!el) throw new Error(`row ${id} not found`);
  return el;
}

function pointer(el: Element, type: string, clientX: number, clientY: number) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0 });
  // jsdom は PointerEvent を持たないため、ポインターの ID と種類を足す
  Object.defineProperty(e, 'pointerId', { value: 1 });
  Object.defineProperty(e, 'pointerType', { value: 'mouse' });
  el.dispatchEvent(e);
  flushSync();
}

describe('SortableList（キーボード）', () => {
  it('行にフォーカスがあるとき、下の上下キーで一つ動かす（onmove に動かす先の位置）', () => {
    const { onmove } = render();
    const b = bodyOf('b');
    b.focus();
    b.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(onmove).toHaveBeenCalledWith('b', 2);
  });

  it('端の行では動かさない（onmove を呼ばない）', () => {
    const { onmove } = render();
    bodyOf('a').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    bodyOf('c').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    expect(onmove).not.toHaveBeenCalled();
  });

  it('行の中の入力欄での上下キーは、並べ替えにしない（入力欄の操作のまま）', () => {
    const { onmove } = render();
    const input = bodyOf('b').querySelector('input')!;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(onmove).not.toHaveBeenCalled();
  });
});

describe('SortableList（ポインターの取り消し）', () => {
  it('ドラッグのあとに取り消すと、並べ替えず、行の位置も戻す', () => {
    const { onmove } = render();
    const b = bodyOf('b');
    pointer(b, 'pointerdown', 10, 100);
    pointer(b, 'pointermove', 10, 130);
    expect(bodyOf('b').closest('.sortable-list-item')!.classList.contains('sortable-list-item-dragging')).toBe(true);
    pointer(b, 'pointercancel', 10, 130);
    expect(onmove).not.toHaveBeenCalled();
    expect(bodyOf('b').closest('.sortable-list-item')!.classList.contains('sortable-list-item-dragging')).toBe(false);
  });

  it('左スワイプのあとに取り消すと、削除ボタンを出さない', () => {
    render(vi.fn(), { onremove: vi.fn(), removable: () => true });
    const b = bodyOf('b');
    pointer(b, 'pointerdown', 200, 50);
    pointer(b, 'pointermove', 90, 52);
    pointer(b, 'pointercancel', 90, 52);
    const slot = host!.querySelector('[data-sortable-id="b"] .sortable-list-delete-slot');
    expect(slot?.classList.contains('sortable-list-delete-shown')).toBe(false);
  });

  it('ドラッグ中に並びの ID が外から変わったら、その操作を取り消す（別の項目を動かさない）', () => {
    const { onmove, exports } = render();
    const b = bodyOf('b');
    pointer(b, 'pointerdown', 10, 100);
    pointer(b, 'pointermove', 10, 130);
    expect(host!.querySelector('.sortable-list-dragging')).not.toBeNull();
    exports.setItems([ITEMS[0], ITEMS[2]]);
    flushSync();
    expect(host!.querySelector('.sortable-list-dragging')).toBeNull();
    pointer(b, 'pointerup', 10, 130);
    expect(onmove).not.toHaveBeenCalled();
  });
});

describe('SortableList（文脈メニュー）', () => {
  it('行の文字の上では文脈メニューを出さない（入力欄などの操作部品は除く）', () => {
    render();
    const text = bodyOf('a').querySelector('.row-text')!;
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    text.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });

  it('入力欄の上では文脈メニューを止めない', () => {
    render();
    const input = bodyOf('a').querySelector('input')!;
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    input.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
});
