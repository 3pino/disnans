// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import LightboxView from './LightboxView.svelte';
import type { LightboxItem } from '../lib/lightbox';

// 拡大表示の部品（LightboxView）を、実際のビューアー（ImageViewer・PdfViewer）と一緒に動かす。
// tapMode 省略（'close'）は従来どおり（画像・背景のタップで閉じる。拡大中は閉じない）。
// tapMode 'media' は、画像の上のタップを onmediatap に渡して閉じない（ダブルタップの拡大は従来どおり、画像の外のタップは閉じる）。
// jsdom には配置が無いので、画像の矩形だけを決めて測る（実際の見え方は未検証）。

const h = vi.hoisted(() => ({
  getDocument: vi.fn(() => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
        render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
      }),
    }),
    destroy: async () => {},
  })),
}));
vi.mock('../lib/pdfjs', () => ({ loadPdfjs: async () => ({ getDocument: h.getDocument }) }));

/** 画像の表示矩形（舞台の左上からの座標。jsdom の舞台は (0,0) 起点） */
const IMG_BOX = { left: 100, top: 200, right: 300, bottom: 400, width: 200, height: 200, x: 100, y: 200, toJSON() {} };

const PHOTO: LightboxItem = { src: 'a.png', alt: 'a.png', downloadUrl: 'a.png', kind: 'image' };
const PDF: LightboxItem = { src: 'a.pdf', alt: 'a.pdf', downloadUrl: 'a.pdf', kind: 'pdf' };

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  // bind:clientWidth は ResizeObserver を使う（jsdom には無い）
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  target = document.createElement('div');
  document.body.appendChild(target);
});
afterEach(async () => {
  if (instance) await unmount(instance);
  target?.remove();
  instance = undefined;
  target = undefined;
  vi.useRealTimers();
});

type Handlers = { onclose?: () => void; onmediatap?: () => void };
/** 拡大表示を描く。tapMode 省略なら従来どおり */
function render(item: LightboxItem, props: Handlers & { tapMode?: 'close' | 'media' } = {}): { close: ReturnType<typeof vi.fn>; mediatap: ReturnType<typeof vi.fn> } {
  const close = vi.fn(props.onclose);
  const mediatap = vi.fn(props.onmediatap);
  instance = mount(LightboxView, {
    target: target!,
    props: { item, onclose: close, onmediatap: mediatap, ...(props.tapMode ? { tapMode: props.tapMode } : {}) },
  });
  flushSync();
  if (item.kind !== 'pdf') img().getBoundingClientRect = () => IMG_BOX as DOMRect;
  return { close, mediatap };
}

/** いま見ている画像のビューアー（舞台） */
const stage = () => target!.querySelector<HTMLElement>('.lightbox-slide-current .image-viewer')!;
const img = () => target!.querySelector<HTMLImageElement>('.lightbox-slide-current .image-viewer-image')!;
const pdfStage = () => target!.querySelector<HTMLElement>('.lightbox-slide-current .pdf-viewer')!;
const isZoomed = () => stage().classList.contains('zoomed');

type Pt = { x: number; y: number };
/** タッチの事件（jsdom には Touch が無いので、touches・changedTouches を足す） */
function touchEv(type: string, touches: Pt[], changed: Pt[]): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  const t = (p: Pt) => ({ identifier: 1, clientX: p.x, clientY: p.y });
  Object.defineProperty(ev, 'touches', { value: touches.map(t) });
  Object.defineProperty(ev, 'changedTouches', { value: changed.map(t) });
  return ev;
}
/** 指 1 本で、その場所を 1 回タップ（離す） */
function tap(el: HTMLElement, p: Pt): void {
  el.dispatchEvent(touchEv('touchstart', [p], [p]));
  el.dispatchEvent(touchEv('touchend', [], [p]));
  flushSync();
}
/** 画像の中の点・外の点 */
const INSIDE: Pt = { x: 200, y: 300 };
const OUTSIDE: Pt = { x: 20, y: 20 };
/** 待ち時間（300ms）を過ぎるまで */
function wait(ms = 400): void {
  vi.advanceTimersByTime(ms);
  flushSync();
}
/** ダブルタップで拡大する（同じ場所で続けて 2 回） */
function doubleTap(el: HTMLElement, p: Pt): void {
  tap(el, p);
  tap(el, p);
}

describe('tapMode 省略（既定 close）: 従来どおり', () => {
  it('画像の上のタップも、画像の外のタップも、待ってから閉じる', () => {
    const a = render(PHOTO);
    tap(stage(), INSIDE);
    wait();
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(a.mediatap).not.toHaveBeenCalled();
  });

  it('画像の外のタップでも閉じる', () => {
    const a = render(PHOTO);
    tap(stage(), OUTSIDE);
    wait();
    expect(a.close).toHaveBeenCalledTimes(1);
  });

  it('拡大中は、タップで閉じない', () => {
    const a = render(PHOTO);
    doubleTap(stage(), INSIDE);
    wait();
    expect(isZoomed()).toBe(true);
    a.close.mockClear();
    tap(stage(), INSIDE);
    tap(stage(), OUTSIDE);
    wait();
    expect(a.close).not.toHaveBeenCalled();
  });
});

describe("tapMode 'media'（ライブの映像: 画像の上のタップは閉じない）", () => {
  it('画像の上のタップで onmediatap を 1 回呼び、閉じない（待ってから）', () => {
    const a = render(PHOTO, { tapMode: 'media' });
    tap(stage(), INSIDE);
    vi.advanceTimersByTime(100);
    flushSync();
    expect(a.mediatap).not.toHaveBeenCalled();
    wait(300);
    expect(a.mediatap).toHaveBeenCalledTimes(1);
    expect(a.close).not.toHaveBeenCalled();
  });

  it('画像の外のタップは閉じる（onmediatap は呼ばない）', () => {
    const a = render(PHOTO, { tapMode: 'media' });
    tap(stage(), OUTSIDE);
    wait();
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(a.mediatap).not.toHaveBeenCalled();
  });

  it('ダブルタップは拡大に使い、onmediatap も閉じるも呼ばない', () => {
    const a = render(PHOTO, { tapMode: 'media' });
    doubleTap(stage(), INSIDE);
    wait(1000);
    expect(isZoomed()).toBe(true);
    expect(a.mediatap).not.toHaveBeenCalled();
    expect(a.close).not.toHaveBeenCalled();
  });

  it('拡大中に画像の上をタップすると onmediatap を呼ぶ（閉じない）', () => {
    const a = render(PHOTO, { tapMode: 'media' });
    doubleTap(stage(), INSIDE);
    wait();
    expect(isZoomed()).toBe(true);
    tap(stage(), INSIDE);
    wait();
    expect(a.mediatap).toHaveBeenCalledTimes(1);
    expect(a.close).not.toHaveBeenCalled();
  });

  it('拡大中に画像の外をタップしても閉じない', () => {
    const a = render(PHOTO, { tapMode: 'media' });
    doubleTap(stage(), INSIDE);
    wait();
    tap(stage(), OUTSIDE);
    wait();
    expect(a.close).not.toHaveBeenCalled();
    expect(a.mediatap).not.toHaveBeenCalled();
  });

  it('待ちの途中で別の場所をタップしたら、前の画像のタップは実行しない', () => {
    const a = render(PHOTO, { tapMode: 'media' });
    tap(stage(), INSIDE);
    vi.advanceTimersByTime(100);
    tap(stage(), OUTSIDE);
    wait();
    expect(a.mediatap).not.toHaveBeenCalled();
    expect(a.close).toHaveBeenCalledTimes(1);
  });
});

describe('PDF は tapMode に関係なく、画像のタップとして扱わない', () => {
  it("tapMode 'media' でも onmediatap は呼ばず、タップでは閉じない（従来どおり）", () => {
    const a = render(PDF, { tapMode: 'media' });
    tap(pdfStage(), INSIDE);
    wait(1000);
    expect(a.mediatap).not.toHaveBeenCalled();
    expect(a.close).not.toHaveBeenCalled();
  });

  it('tapMode 省略でも同じ（PDF はタップで閉じない）', () => {
    const a = render(PDF);
    tap(pdfStage(), OUTSIDE);
    wait(1000);
    expect(a.close).not.toHaveBeenCalled();
    expect(a.mediatap).not.toHaveBeenCalled();
  });
});
