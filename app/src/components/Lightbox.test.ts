// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import Lightbox from './Lightbox.svelte';
import { ui } from '../lib/stores/ui.svelte';
import type { LightboxItem } from '../lib/lightbox';

// 拡大表示: ←→ キー・横スワイプ（1 本指・等倍のとき）・端では動かさない・拡大中はパン優先・タップで閉じる
const ITEMS: LightboxItem[] = ['a', 'b', 'c'].map((n) => ({ src: `${n}.png`, alt: `${n}.png`, downloadUrl: `${n}.png` }));

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;

beforeEach(() => {
  target = document.createElement('div');
  document.body.appendChild(target);
  // jsdom には PointerEvent が無いので、Pointer の性質を足す
  instance = mount(Lightbox, { target });
});
afterEach(async () => {
  if (instance) await unmount(instance);
  target?.remove();
  ui.lightbox = null;
  ui.lightboxGallery = null;
  instance = undefined;
  target = undefined;
  vi.useRealTimers();
});

function open(index = 1): void {
  ui.openLightbox(ITEMS[index], () => ITEMS);
  flushSync();
}
const stage = () => target!.querySelector<HTMLElement>('.lightbox-stage')!;
const img = () => target!.querySelector<HTMLImageElement>('.lightbox-image')!;
const shown = () => ui.lightbox?.src;

function key(k: string, el: EventTarget = window): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  flushSync();
  return ev;
}

/** 1 本指（タッチ）の動き。x・y は、動かし始めからの移動量（px） */
function touchDrag(dx: number, dy: number): void {
  const down = touch('pointerdown', 200, 300);
  stage().dispatchEvent(down);
  flushSync();
  stage().dispatchEvent(touch('pointermove', 200 + dx, 300 + dy));
  flushSync();
  stage().dispatchEvent(touch('pointerup', 200 + dx, 300 + dy));
  flushSync();
}
function touch(type: string, x: number, y: number, pointerId = 1): MouseEvent {
  const ev = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(ev, 'pointerType', { value: 'touch' });
  Object.defineProperty(ev, 'pointerId', { value: pointerId });
  return ev;
}

describe('拡大表示の前後（←→キー・ボタン）', () => {
  it('← で前、→ で次の画像へ。端では動かない', () => {
    open(1);
    key('ArrowRight');
    expect(shown()).toBe('c.png');
    key('ArrowRight');
    expect(shown()).toBe('c.png'); // 最後
    key('ArrowLeft');
    key('ArrowLeft');
    expect(shown()).toBe('a.png');
    key('ArrowLeft');
    expect(shown()).toBe('a.png'); // 最初
  });

  it('入力欄にフォーカスがあっても、拡大表示が優先する（入力欄は受け取らない）', () => {
    open(1);
    const input = document.createElement('textarea');
    document.body.appendChild(input);
    const inputGot = vi.fn();
    input.addEventListener('keydown', inputGot);
    input.focus();
    key('ArrowRight', input);
    expect(shown()).toBe('c.png');
    expect(inputGot).not.toHaveBeenCalled();
    input.remove();
  });

  it('ボタン（‹ ›）は端では出さない。押すと動く', () => {
    open(0);
    expect(target!.querySelector('.lightbox-prev')).toBeNull();
    expect(target!.querySelector('.lightbox-next')).not.toBeNull();
    (target!.querySelector('.lightbox-next') as HTMLButtonElement).click();
    flushSync();
    expect(shown()).toBe('b.png');
    open(2);
    expect(target!.querySelector('.lightbox-next')).toBeNull();
    (target!.querySelector('.lightbox-prev') as HTMLButtonElement).click();
    flushSync();
    expect(shown()).toBe('b.png');
  });

  it('移るとき、表示は等倍・中央に戻る（拡大していた画像を引き継がない）', () => {
    open(1);
    // 拡大（ホイール + Ctrl）
    stage().dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -200, bubbles: true, cancelable: true }));
    flushSync();
    expect(img().style.transform).not.toContain('scale(1)');
    key('ArrowRight');
    expect(img().style.transform).toContain('scale(1)');
  });

  it('修飾キー付き（Alt・Ctrl・Meta）の矢印は動かさない（ブラウザの戻る等に任せる）', () => {
    open(1);
    const ev = new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    flushSync();
    expect(shown()).toBe('b.png');
    expect(ev.defaultPrevented).toBe(false);
  });

  it('一覧が無い（ギャラリーなし）ときは、前後の操作は出ず、矢印も動かさない', () => {
    ui.openLightbox(ITEMS[1]);
    flushSync();
    expect(target!.querySelector('.lightbox-nav')).toBeNull();
    key('ArrowRight');
    expect(shown()).toBe('b.png');
  });
});

describe('拡大表示の横スワイプ（1 本指・等倍のときだけ）', () => {
  it('左へ横に 56px 以上動かすと次、右へ動かすと前', () => {
    open(1);
    touchDrag(-80, 4);
    expect(shown()).toBe('c.png');
    touchDrag(80, -3);
    expect(shown()).toBe('b.png');
  });

  it('距離が足りない・縦の動きの方が大きい（斜め・縦）は動かさない', () => {
    open(1);
    touchDrag(-30, 0);
    expect(shown()).toBe('b.png');
    touchDrag(-60, 200);
    expect(shown()).toBe('b.png');
  });

  it('端では動かさず、タップ扱いにもしない（横に動いたので閉じない）', () => {
    vi.useFakeTimers();
    open(0);
    touchDrag(80, 0); // 最初の前へ
    expect(shown()).toBe('a.png');
    vi.advanceTimersByTime(400);
    flushSync();
    expect(ui.lightbox).not.toBeNull();
  });

  it('拡大中は横に動かしても動かない（パンを優先する）', () => {
    open(1);
    stage().dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -200, bubbles: true, cancelable: true }));
    flushSync();
    touchDrag(-120, 0);
    expect(shown()).toBe('b.png');
  });

  it('マウスの横ドラッグでは動かさない（スワイプは 1 本指のタッチだけ）', () => {
    open(1);
    const down = new MouseEvent('pointerdown', { bubbles: true, clientX: 200, clientY: 300, button: 0 });
    Object.defineProperty(down, 'pointerType', { value: 'mouse' });
    Object.defineProperty(down, 'pointerId', { value: 1 });
    stage().dispatchEvent(down);
    const up = new MouseEvent('pointerup', { bubbles: true, clientX: 100, clientY: 300, button: 0 });
    Object.defineProperty(up, 'pointerType', { value: 'mouse' });
    Object.defineProperty(up, 'pointerId', { value: 1 });
    stage().dispatchEvent(up);
    flushSync();
    expect(shown()).toBe('b.png');
  });

  it('2 本指（ピンチ）のあとは、残りの指で横に動かしてもスワイプにしない', () => {
    open(1);
    stage().dispatchEvent(touch('pointerdown', 150, 300, 1));
    stage().dispatchEvent(touch('pointerdown', 250, 300, 2));
    stage().dispatchEvent(touch('pointerup', 250, 300, 2));
    flushSync();
    touchDrag(-120, 0);
    expect(shown()).toBe('b.png');
  });
});

describe('背景タップで閉じる（既存の動作は残す）', () => {
  it('等倍で 1 本指のタップは、少し待ってから閉じる', () => {
    vi.useFakeTimers();
    open(1);
    touchDrag(0, 0);
    vi.advanceTimersByTime(400);
    flushSync();
    expect(ui.lightbox).toBeNull();
  });

  it('スワイプで移ったあとは、閉じない', () => {
    vi.useFakeTimers();
    open(1);
    touchDrag(-80, 0);
    vi.advanceTimersByTime(400);
    flushSync();
    expect(ui.lightbox?.src).toBe('c.png');
  });
});
