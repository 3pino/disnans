// @vitest-environment jsdom
// 並べ替えの部品の DOM のテスト（キーボード・ポインターの取り消し・並びの変化・文脈メニュー）。
// ポインターの座標は jsdom では本物の描画の位置を持たないため、判定は lib/sortable.test.ts の純関数で確かめ、ここでは配線を見る。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/** タッチの一連の操作（pointerdown → 長押しの時間 → pointermove → lostpointercapture → pointerup）。実機で起きた順を再現する */
describe('SortableList（タッチの一連の操作）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function touchPointer(el: Element, type: string, clientX: number, clientY: number, bubbles = true) {
    const e = new MouseEvent(type, { bubbles, cancelable: true, clientX, clientY, button: 0 });
    Object.defineProperty(e, 'pointerId', { value: 7 });
    Object.defineProperty(e, 'pointerType', { value: 'touch' });
    el.dispatchEvent(e);
    flushSync();
  }

  /** 捕捉の解放（実機の lostpointercapture と同じく、ポインターの ID を持つ） */
  function lostCapture(el: Element) {
    const e = new Event('lostpointercapture', { bubbles: true });
    Object.defineProperty(e, 'pointerId', { value: 7 });
    el.dispatchEvent(e);
    flushSync();
  }

  /** 行の中の文字（子要素）で、捕捉の解放が泡のように行へ届く */
  function childCaptureLost(id: string) {
    lostCapture(bodyOf(id).querySelector('.row-text')!);
  }

  it('長押し（400ms）のあとに縦へ動かすと並べ替えが始まり、離したとき動かし先を通知する', () => {
    const { onmove } = render();
    const b = bodyOf('b');
    touchPointer(b, 'pointerdown', 10, 100);
    vi.advanceTimersByTime(400);
    flushSync();
    touchPointer(b, 'pointermove', 10, 130);
    expect(host!.querySelector('.sortable-list-dragging')).not.toBeNull();
    touchPointer(b, 'pointerup', 10, 130);
    expect(onmove).toHaveBeenCalledWith('b', 2);
  });

  it('長押しの前に縦へ動かすと、並べ替えにならない（ページのスクロールに任せる）', () => {
    const { onmove } = render();
    const b = bodyOf('b');
    touchPointer(b, 'pointerdown', 10, 100);
    touchPointer(b, 'pointermove', 10, 120);
    vi.advanceTimersByTime(400);
    flushSync();
    expect(host!.querySelector('.sortable-list-dragging')).toBeNull();
    touchPointer(b, 'pointerup', 10, 120);
    expect(onmove).not.toHaveBeenCalled();
  });

  it('行の中の文字の捕捉の解放では、並べ替えを取り消さない（実機: 長押しの直後に途切れた）', () => {
    const { onmove } = render();
    const b = bodyOf('b');
    touchPointer(b, 'pointerdown', 10, 100);
    vi.advanceTimersByTime(400);
    flushSync();
    touchPointer(b, 'pointermove', 10, 130);
    childCaptureLost('b');
    expect(host!.querySelector('.sortable-list-dragging')).not.toBeNull();
    touchPointer(b, 'pointermove', 10, 140);
    touchPointer(b, 'pointerup', 10, 140);
    expect(onmove).toHaveBeenCalledWith('b', 2);
  });

  it('行自身の捕捉が外れたら、取り消す（並べ替えず、行を戻す）', () => {
    const { onmove } = render();
    const b = bodyOf('b');
    touchPointer(b, 'pointerdown', 10, 100);
    vi.advanceTimersByTime(400);
    flushSync();
    touchPointer(b, 'pointermove', 10, 130);
    lostCapture(b);
    expect(host!.querySelector('.sortable-list-dragging')).toBeNull();
    touchPointer(b, 'pointerup', 10, 130);
    expect(onmove).not.toHaveBeenCalled();
  });
});

describe('SortableList（削除モード）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (navigator as { vibrate?: unknown }).vibrate;
  });

  function pointerAt(el: Element, type: string, pointerType: string, clientX: number, clientY: number) {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0 });
    Object.defineProperty(e, 'pointerId', { value: 3 });
    Object.defineProperty(e, 'pointerType', { value: pointerType });
    el.dispatchEvent(e);
    flushSync();
  }

  const deleting = () => host!.querySelector('.sortable-list-deleting') !== null;
  const xOf = (id: string) => host!.querySelector<HTMLButtonElement>(`[data-sortable-id="${id}"] .row-x`);

  /** 押し続ける（動かさない）。タッチ・マウスとも 700ms で削除モードに入る */
  function hold(pointerType: string, id = 'b') {
    pointerAt(bodyOf(id), 'pointerdown', pointerType, 10, 100);
    vi.advanceTimersByTime(700);
    flushSync();
  }

  it('行を押し続けると（動かさずに 700ms）削除モードに入り、削除できる行だけに × が出る', () => {
    render(vi.fn(), { onremove: vi.fn(), removable: (x) => x.id !== 'a' });
    hold('touch');
    expect(deleting()).toBe(true);
    expect(xOf('b')).not.toBeNull();
    expect(xOf('a')).toBeNull();
  });

  it('削除モードに入るとき、短い振動を一度だけ出す（対応していない環境では何もしない）', () => {
    const vibrate = vi.fn((_ms: number) => true);
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: vibrate });
    render(vi.fn(), { onremove: vi.fn(), removable: () => true });
    hold('touch');
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(vibrate.mock.calls[0]![0]).toBeGreaterThan(0);
  });

  it('振動がなくても、削除モードには入る', () => {
    render(vi.fn(), { onremove: vi.fn(), removable: () => true });
    expect(() => hold('touch')).not.toThrow();
    expect(deleting()).toBe(true);
  });

  it('マウスでも、押し続けると削除モードに入る', () => {
    render(vi.fn(), { onremove: vi.fn(), removable: () => true });
    hold('mouse');
    expect(deleting()).toBe(true);
  });

  it('動かしてから（並べ替え・スクロールになったら）削除モードには入らない', () => {
    render(vi.fn(), { onremove: vi.fn(), removable: () => true });
    pointerAt(bodyOf('b'), 'pointerdown', 'mouse', 10, 100);
    pointerAt(bodyOf('b'), 'pointermove', 'mouse', 10, 130);
    vi.advanceTimersByTime(1000);
    flushSync();
    expect(deleting()).toBe(false);
  });

  it('× を押すと削除する（削除モードは続く）', () => {
    const onremove = vi.fn();
    render(vi.fn(), { onremove, removable: () => true });
    hold('touch');
    xOf('b')!.click();
    flushSync();
    expect(onremove).toHaveBeenCalledWith('b');
    expect(deleting()).toBe(true);
  });

  it('削除モードの中の並べ替えは、押す時間が短くても始まる（150ms）', () => {
    const onmove = vi.fn();
    render(onmove, { onremove: vi.fn(), removable: () => true });
    hold('touch');
    const b = bodyOf('b');
    pointerAt(b, 'pointerdown', 'touch', 10, 100);
    vi.advanceTimersByTime(150);
    flushSync();
    pointerAt(b, 'pointermove', 'touch', 10, 130);
    pointerAt(b, 'pointerup', 'touch', 10, 130);
    expect(onmove).toHaveBeenCalledWith('b', 2);
  });

  it('リストの外をタップすると、削除モードが終わる', () => {
    render(vi.fn(), { onremove: vi.fn(), removable: () => true });
    hold('touch');
    pointerAt(document.body, 'pointerdown', 'mouse', 0, 0);
    flushSync();
    expect(deleting()).toBe(false);
    expect(xOf('b')).toBeNull();
  });

  it('リストの中（行の文字）をタップしても、削除モードは終わらない', () => {
    render(vi.fn(), { onremove: vi.fn(), removable: () => true });
    hold('touch');
    pointerAt(bodyOf('a').querySelector('.row-text')!, 'pointerdown', 'mouse', 0, 0);
    flushSync();
    expect(deleting()).toBe(true);
  });

  it('Escape で削除モードが終わり、その Escape は止める（ほかの画面の動作を妨げない）', () => {
    render(vi.fn(), { onremove: vi.fn(), removable: () => true });
    hold('touch');
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    flushSync();
    expect(deleting()).toBe(false);
    expect(e.defaultPrevented).toBe(true);
  });

  it('行にフォーカスがあるとき Delete で削除モードに入る（キーボードで削除できる）', () => {
    render(vi.fn(), { onremove: vi.fn(), removable: () => true });
    bodyOf('b').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
    flushSync();
    expect(deleting()).toBe(true);
    expect(xOf('b')).not.toBeNull();
  });

  it('削除モードでも、上下キーで行を動かせる', () => {
    const onmove = vi.fn();
    render(onmove, { onremove: vi.fn(), removable: () => true });
    bodyOf('b').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
    flushSync();
    bodyOf('b').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    expect(onmove).toHaveBeenCalledWith('b', 0);
  });

  it('削除の項目がない一覧（onremove なし）では、押し続けても削除モードに入らない', () => {
    render();
    hold('touch');
    expect(deleting()).toBe(false);
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
