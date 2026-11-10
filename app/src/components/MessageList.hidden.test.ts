// @vitest-environment jsdom
// チャットが隠れて（通話の画面など）戻ったとき、スクロール位置を保ち、過去を勝手に読み込まない。
// 隠れたスクロール箱は scrollTop が 0 と読める（Chromium は戻すと元の位置に戻る）。それを「上まで来た」と取って過去を読み込んでいた。
// jsdom には配置が無いので、スクロール箱の寸法と ResizeObserver を決めて動かす（実際の見え方は未検証）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import MessageList from './MessageList.svelte';

vi.mock('./MessageItem.svelte', async () => ({ default: (await import('./testing/ChatChildStub.svelte')).default }));

let observers: Array<() => void> = [];
class FakeResizeObserver {
  constructor(cb: () => void) {
    observers.push(cb);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;
const box = { top: 0, height: 600, content: 5000 };
const loadOlder = vi.fn(async () => {});

function timeline() {
  return { messages: [], pending: [], loaded: true, loading: false, loadingOlder: false, hasMore: true, error: null, loadOlder };
}

/** スクロール箱。隠れる（display: none）と、高さ 0・scrollTop 0 になる */
function setupScroller(): HTMLElement {
  const el = target!.querySelector<HTMLElement>('.message-list-scroller')!;
  Object.defineProperty(el, 'clientHeight', { get: () => box.height, configurable: true });
  Object.defineProperty(el, 'scrollHeight', { get: () => box.content, configurable: true });
  Object.defineProperty(el, 'scrollTop', { get: () => box.top, set: (v: number) => (box.top = v), configurable: true });
  return el;
}
const fire = () => observers.forEach((cb) => cb());
function scrollTo(el: HTMLElement, top: number) {
  box.top = top;
  el.dispatchEvent(new Event('scroll'));
  flushSync();
}
function hide() {
  box.height = 0;
  box.top = 0;
  fire();
}
function show() {
  box.height = 600;
  fire(); // 戻した直後は scrollTop が 0 のまま
}

beforeEach(() => {
  observers = [];
  loadOlder.mockClear();
  box.top = 0;
  box.height = 600;
  box.content = 5000;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
  // 本物は一番下に止まる。ここでは scrollHeight まで動かす（下へ張り付いたかだけを見る）
  HTMLElement.prototype.scrollTo = function (o?: ScrollToOptions | number) {
    if (typeof o === 'object') box.top = o.top ?? 0;
  } as never;
  target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(MessageList, { target, props: { timeline: timeline() as never, active: true } });
  flushSync();
});
afterEach(async () => {
  if (instance) await unmount(instance);
  target?.remove();
  instance = undefined;
});

describe('隠れて戻ったときのスクロール', () => {
  it('上のほうを見ていたとき、隠れても戻しても、過去を読み込まず、位置は元のまま（位置が失われた環境では戻す）', async () => {
    const el = setupScroller();
    await tick();
    scrollTo(el, 1500); // 上から 1500（下からは離れている。400 より下）
    loadOlder.mockClear();
    hide();
    show();
    expect(box.top).toBe(1500);
    expect(loadOlder).not.toHaveBeenCalled();
  });

  it('隠れている間に（0 になって）出る scroll の事件では、過去を読み込まない', async () => {
    const el = setupScroller();
    await tick();
    scrollTo(el, 1500);
    loadOlder.mockClear();
    box.height = 0;
    scrollTo(el, 0);
    fire();
    expect(loadOlder).not.toHaveBeenCalled();
  });

  it('一番下にいたときは、戻したら下へ', async () => {
    const el = setupScroller();
    await tick();
    scrollTo(el, 5000 - 600); // 一番下
    hide();
    show();
    expect(box.top).toBe(5000); // scrollHeight へ（本物は一番下に止まる）
  });

  it('見えている普通の状態では、上まで来たら今までどおり過去を読み込む', async () => {
    const el = setupScroller();
    await tick();
    scrollTo(el, 100);
    expect(loadOlder).toHaveBeenCalled();
  });
});
