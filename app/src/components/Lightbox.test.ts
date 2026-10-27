// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import Lightbox from './Lightbox.svelte';
import { ui } from '../lib/stores/ui.svelte';
import type { LightboxItem } from '../lib/lightbox';

// 拡大表示: ←→ キー・横スワイプ（1 本指・等倍のとき。指に合わせて隣が出てくる）・端では動かさない・拡大中はパン優先・タップで閉じる
const ITEMS: LightboxItem[] = ['a', 'b', 'c'].map((n) => ({ src: `${n}.png`, alt: `${n}.png`, downloadUrl: `${n}.png` }));

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  target = document.createElement('div');
  document.body.appendChild(target);
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
/** いま見ている画像のビューアー（真ん中） */
const stage = () => target!.querySelector<HTMLElement>('.lightbox-slide-current .image-viewer')!;
const img = () => target!.querySelector<HTMLImageElement>('.lightbox-slide-current .image-viewer-image')!;
const track = () => target!.querySelector<HTMLElement>('.lightbox-track')!;
const shown = () => ui.lightbox?.src;
/** 切り替えのアニメーションを終える */
function settle(): void {
  vi.advanceTimersByTime(300);
  flushSync();
}

function key(k: string, el: EventTarget = window): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  flushSync();
  return ev;
}

type Pt = { id?: number; x: number; y: number };
/** タッチの事件（jsdom には Touch が無いので、touches・changedTouches を足す） */
function touchEv(type: string, touches: Pt[], changed: Pt[]): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  const t = (p: Pt) => ({ identifier: p.id ?? 1, clientX: p.x, clientY: p.y });
  Object.defineProperty(ev, 'touches', { value: touches.map(t) });
  Object.defineProperty(ev, 'changedTouches', { value: changed.map(t) });
  return ev;
}
/** 1 本指で、(200, 300) から dx・dy 動かして離す。途中で止めると（end=false）離さない */
function touchDrag(dx: number, dy: number, end = true): void {
  const el = stage();
  const from = { x: 200, y: 300 };
  const to = { x: 200 + dx, y: 300 + dy };
  el.dispatchEvent(touchEv('touchstart', [from], [from]));
  flushSync();
  el.dispatchEvent(touchEv('touchmove', [{ x: 200 + dx / 2, y: 300 + dy / 2 }], [{ x: 200 + dx / 2, y: 300 + dy / 2 }]));
  el.dispatchEvent(touchEv('touchmove', [to], [to]));
  flushSync();
  if (!end) return;
  // ゆっくり離す（速さではなく、距離で決まるように）
  vi.advanceTimersByTime(1000);
  el.dispatchEvent(touchEv('touchend', [], [to]));
  flushSync();
}
function ctrlWheel(deltaY = -200): void {
  stage().dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY, bubbles: true, cancelable: true }));
  flushSync();
}

describe('拡大表示の前後（←→キー・ボタン）', () => {
  it('← で前、→ で次へ（横に流してから移る）。端では動かない', () => {
    open(1);
    key('ArrowRight');
    settle();
    expect(shown()).toBe('c.png');
    key('ArrowRight');
    settle();
    expect(shown()).toBe('c.png'); // 最後
    key('ArrowLeft');
    settle();
    key('ArrowLeft');
    settle();
    expect(shown()).toBe('a.png');
    key('ArrowLeft');
    settle();
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
    settle();
    expect(shown()).toBe('c.png');
    expect(inputGot).not.toHaveBeenCalled();
    input.remove();
  });

  it('ボタン（‹ ›）は端では出さない。押すと動く', () => {
    open(0);
    expect(target!.querySelector('.lightbox-prev')).toBeNull();
    (target!.querySelector('.lightbox-next') as HTMLButtonElement).click();
    settle();
    expect(shown()).toBe('b.png');
    open(2);
    expect(target!.querySelector('.lightbox-next')).toBeNull();
    (target!.querySelector('.lightbox-prev') as HTMLButtonElement).click();
    settle();
    expect(shown()).toBe('b.png');
  });

  it('前後のファイルも隣に置き、移るとそれが真ん中に来る', () => {
    open(1);
    const slides = () => [...target!.querySelectorAll<HTMLElement>('.lightbox-slide')].map((s) => s.querySelector('img')!.getAttribute('src'));
    expect(slides()).toEqual(['a.png', 'b.png', 'c.png']);
    const nextImg = target!.querySelectorAll('.lightbox-slide img')[2];
    key('ArrowRight');
    settle();
    // 同じ部品のまま（作り直さない）
    expect(img()).toBe(nextImg);
  });

  it('拡大中は ←→ で移らない（ビューアーの移動・スクロールに残す）', () => {
    open(1);
    ctrlWheel();
    const ev = key('ArrowRight');
    settle();
    expect(shown()).toBe('b.png');
    expect(ev.defaultPrevented).toBe(false);
  });

  it('移るとき、表示は等倍・中央に戻る（拡大していた画像を引き継がない）', () => {
    open(1);
    ctrlWheel();
    const zoomedImg = img();
    expect(zoomedImg.style.transform).not.toContain('scale(1)');
    (target!.querySelector('.lightbox-next') as HTMLButtonElement).click();
    settle();
    expect(shown()).toBe('c.png');
    expect(zoomedImg.style.transform).toContain('scale(1)');
    // 移った先では、また ←→ で動ける（等倍）
    key('ArrowLeft');
    settle();
    expect(shown()).toBe('b.png');
  });

  it('修飾キー付き（Alt・Ctrl・Meta）の矢印は動かさない（ブラウザの戻る等に任せる）', () => {
    open(1);
    const ev = new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    settle();
    expect(shown()).toBe('b.png');
    expect(ev.defaultPrevented).toBe(false);
  });

  it('一覧が無い（ギャラリーなし）ときは、前後の操作は出ず、矢印も動かさない', () => {
    ui.openLightbox(ITEMS[1]);
    flushSync();
    expect(target!.querySelector('.lightbox-nav')).toBeNull();
    key('ArrowRight');
    settle();
    expect(shown()).toBe('b.png');
  });
});

describe('拡大表示の横スワイプ（1 本指・等倍のときだけ）', () => {
  it('動かしている間は、指に合わせて並びがずれる（隣が出てくる）', () => {
    open(1);
    touchDrag(-120, 0, false);
    expect(track().style.transform).toBe('translateX(-120px)');
  });

  it('左へ幅の 1/4 以上動かすと次、右へ動かすと前', () => {
    open(1);
    touchDrag(-400, 4);
    settle();
    expect(shown()).toBe('c.png');
    touchDrag(400, -3);
    settle();
    expect(shown()).toBe('b.png');
  });

  it('距離が足りない・縦の動きの方が大きいときは動かさず、元の位置に戻す', () => {
    open(1);
    touchDrag(-30, 0);
    settle();
    expect(shown()).toBe('b.png');
    expect(track().style.transform).toBe('translateX(0px)');
    touchDrag(-60, 200);
    settle();
    expect(shown()).toBe('b.png');
  });

  it('端では少しだけ動いて戻り、タップ扱いにもしない（閉じない）', () => {
    open(0);
    touchDrag(400, 0, false);
    expect(track().style.transform).toBe('translateX(120px)');
    stage().dispatchEvent(touchEv('touchend', [], [{ x: 600, y: 300 }]));
    settle();
    expect(shown()).toBe('a.png');
    vi.advanceTimersByTime(400);
    flushSync();
    expect(ui.lightbox).not.toBeNull();
  });

  it('拡大中は横に動かしても移らない（パンを優先する）', () => {
    open(1);
    ctrlWheel();
    touchDrag(-400, 0);
    settle();
    expect(shown()).toBe('b.png');
  });

  it('2 本指になったら、スワイプはやめる', () => {
    open(1);
    const a = { id: 1, x: 200, y: 300 };
    stage().dispatchEvent(touchEv('touchstart', [a], [a]));
    stage().dispatchEvent(touchEv('touchmove', [{ id: 1, x: 100, y: 300 }], [{ id: 1, x: 100, y: 300 }]));
    const b = { id: 2, x: 300, y: 300 };
    stage().dispatchEvent(touchEv('touchstart', [{ id: 1, x: 100, y: 300 }, b], [b]));
    stage().dispatchEvent(touchEv('touchend', [], [{ id: 1, x: 100, y: 300 }, b]));
    settle();
    expect(shown()).toBe('b.png');
    expect(track().style.transform).toBe('translateX(0px)');
  });
});

describe('背景タップで閉じる', () => {
  it('等倍で 1 本指のタップは、少し待ってから閉じる', () => {
    open(1);
    const p = { x: 200, y: 300 };
    stage().dispatchEvent(touchEv('touchstart', [p], [p]));
    stage().dispatchEvent(touchEv('touchend', [], [p]));
    vi.advanceTimersByTime(400);
    flushSync();
    expect(ui.lightbox).toBeNull();
  });

  it('スワイプで移ったあとは、閉じない', () => {
    open(1);
    touchDrag(-400, 0);
    settle();
    vi.advanceTimersByTime(400);
    flushSync();
    expect(ui.lightbox?.src).toBe('c.png');
  });
});
