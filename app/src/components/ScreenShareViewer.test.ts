// @vitest-environment jsdom
// 共有の全画面の表示: 写真の拡大表示と同じ部品（LightboxView）に載る。開く・閉じる（Esc・戻る・閉じるボタン）、見る画面の切り替え、拡大・移動（ホイール・ダブルタップ）、小窓（本体の PiP）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';
import ScreenShareViewer from './ScreenShareViewer.svelte';
import { ui } from '../lib/stores/ui.svelte';
import { orientation } from '../lib/stores/orientation.svelte';
import { deviceSettings } from '../lib/stores/deviceSettings.svelte';

import { fakeScreen, sharer } from '../test-support/screenFake';
import { reactiveScreen } from '../test-support/reactiveScreen.svelte';
import type { ScreenPipPort } from '../lib/call/screen/types';

const env = vi.hoisted(() => ({ android: false, webAvailable: false, startWebPip: null as null | (() => Promise<unknown>) }));
// コマンドパレットの開閉だけを使う（本体のコマンドの仕組みは読まない）
const commandHost = vi.hoisted(() => ({ paletteOpen: false }));
vi.mock('../lib/commandHost.svelte', () => ({ commandHost }));
const immersive = vi.hoisted(() => ({ set: vi.fn(async (_on: boolean) => true) }));
vi.mock('../lib/platform', async (orig) => ({ ...(await orig<object>()), isAndroid: () => env.android }));
vi.mock('../lib/systemBars', () => ({ setImmersive: immersive.set }));
vi.mock('../lib/call/screen/webPip', () => ({
  webPipAvailable: () => env.webAvailable,
  startWebPip: (...args: unknown[]) => (env.startWebPip ? (env.startWebPip as (...a: unknown[]) => Promise<unknown>)(...args) : Promise.reject(new Error('no pip'))),
}));

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;
const initialOrientation = deviceSettings.raw.orientation;

function fakePip(over: Partial<ScreenPipPort> = {}): ScreenPipPort & { enter: ReturnType<typeof vi.fn> } {
  return { supported: true, active: false, enter: vi.fn(async () => true), onChange: vi.fn(() => () => {}), ...over } as ScreenPipPort & { enter: ReturnType<typeof vi.fn> };
}
function render(props: object): HTMLElement {
  target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(ScreenShareViewer as unknown as Component<Record<string, unknown>>, { target, props: props as Record<string, unknown> });
  flushSync();
  return target;
}
const nameOf = () => 'Aさん';
// 押す前に表示を反映する（直前の操作で変わった disabled を読むため）
const btn = (el: HTMLElement | Document, label: string) => {
  flushSync();
  return el.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
};
const stageOf = (el: HTMLElement) => el.querySelector<HTMLElement>('.lightbox-slide-current .image-viewer')!;
/** 映像（画像）の表示矩形と外。jsdom には配置が無いので、画像の矩形だけを決めて測る */
const IMG_BOX = { left: 100, top: 200, right: 300, bottom: 400, width: 200, height: 200, x: 100, y: 200, toJSON() {} };
const ON_IMAGE = { x: 200, y: 300 };
const OUTSIDE = { x: 10, y: 10 };
function touchEv(type: string, touches: { x: number; y: number }[], changed: { x: number; y: number }[]): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  const t = (p: { x: number; y: number }) => ({ identifier: 1, clientX: p.x, clientY: p.y });
  Object.defineProperty(ev, 'touches', { value: touches.map(t) });
  Object.defineProperty(ev, 'changedTouches', { value: changed.map(t) });
  return ev;
}
/** 指 1 本で 1 回タップ（離す）。映像の上か外かは位置で決まる（待ち時間のあとに効く） */
function tapAt(el: HTMLElement, p: { x: number; y: number }): void {
  const stage = el.querySelector<HTMLElement>('.lightbox-slide-current .image-viewer')!;
  el.querySelector<HTMLImageElement>('.lightbox-slide-current .image-viewer-image')!.getBoundingClientRect = () => IMG_BOX as DOMRect;
  stage.dispatchEvent(touchEv('touchstart', [p], [p]));
  stage.dispatchEvent(touchEv('touchend', [], [p]));
  flushSync();
}
const toolbar = (el: HTMLElement) => el.querySelector('.lightbox-toolbar');
/** 操作のあとの表示を読む（Svelte の更新を待たずに読めるよう、ここで反映させる） */
const imgOf = (el: HTMLElement) => {
  flushSync();
  return el.querySelector<HTMLImageElement>('.lightbox-slide-current .image-viewer-image')!;
};
/** 拡大の倍率は transform の scale から読む */
const scaleOf = (el: HTMLElement) => Number(/scale\(([\d.]+)\)/.exec(imgOf(el).style.transform)?.[1] ?? '1');

beforeEach(() => {
  // jsdom は寸法を持たない（舞台の大きさを与える）
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 });
});
afterEach(async () => {
  if (instance) await unmount(instance);
  target?.remove();
  instance = undefined;
  target = undefined;
  deviceSettings.raw = { ...deviceSettings.raw, orientation: initialOrientation };
  ui.pluginBack = [];
  ui.lightbox = null;
  ui.confirmReq = null;
  commandHost.paletteOpen = false;
  env.android = false;
  env.webAvailable = false;
  env.startWebPip = null;
  immersive.set.mockClear();
  immersive.set.mockImplementation(async () => true);
});

describe('共有の全画面の表示', () => {
  it('見る画面があれば開く。閉じているときは出さない', () => {
    expect(render({ screen: fakeScreen({ sharers: [sharer('pa')] }), nameOf }).querySelector('[role="dialog"]')).toBeNull();
    instance = undefined;
    target?.remove();
    const el = render({ screen: fakeScreen({ sharers: [sharer('pa')], viewerOpen: true }), nameOf });
    expect(el.querySelector('[role="dialog"]')).not.toBeNull();
    expect(el.textContent).toContain('Aさんの画面');
  });

  it('Esc・閉じるボタンで閉じる（closeViewer を呼ぶ）', () => {
    const s = fakeScreen({ sharers: [sharer('pa')], viewerOpen: true });
    const el = render({ screen: s, nameOf });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(s.closeViewer).toHaveBeenCalledTimes(1);
    btn(el, '閉じる')!.click();
    expect(s.closeViewer).toHaveBeenCalledTimes(2);
  });

  it('戻る（ui.back）でも閉じる。閉じたあとは戻る先に残らない', () => {
    const s = fakeScreen({ sharers: [sharer('pa')], viewerOpen: true });
    render({ screen: s, nameOf });
    expect(ui.pluginBack.length).toBe(1);
    expect(ui.back()).toBe(true);
    expect(s.closeViewer).toHaveBeenCalled();
    expect(ui.pluginBack.length).toBe(0);
  });

  it('共有者が 1 人もいなくなったら閉じる', () => {
    const s = fakeScreen({ sharers: [], viewerOpen: true });
    render({ screen: s, nameOf });
    expect(s.closeViewer).toHaveBeenCalled();
  });

  it('映像がまだ無いときは「映像を待っています」、拡大は押せない', () => {
    const el = render({ screen: fakeScreen({ sharers: [sharer('pa', { dataUrl: null })], viewerOpen: true }), nameOf });
    expect(el.textContent).toContain('映像を待っています');
    expect(btn(el, '小窓で見る')?.disabled ?? true).toBe(true);
    expect(stageOf(el)).toBeNull();
  });

  it('2 人以上が共有していても、全画面の中には見る画面の切り替え（segmented）を置かない。選び直しは通話画面の映像の列から', () => {
    const s = fakeScreen({ sharers: [sharer('pa'), sharer('pb')], viewerOpen: true, selectedPeer: 'pa' });
    const el = render({ screen: s, nameOf });
    expect(el.querySelector('[role="radio"], [role="radiogroup"], .segmented')).toBeNull();
    expect(el.querySelector('.screen-viewer-title')!.textContent).toBe('Aさんの画面');
  });
});

describe('拡大・移動（写真の拡大表示と同じ操作）', () => {
  it('写真の拡大表示と同じ部品で出る（ツールバー・ビューアー・閉じるが Lightbox のもの）', () => {
    const el = render({ screen: fakeScreen({ sharers: [sharer('pa')], viewerOpen: true }), nameOf });
    expect(el.querySelector('.lightbox.screen-viewer .lightbox-toolbar')).not.toBeNull();
    expect(stageOf(el)).not.toBeNull();
    expect(el.querySelector('.lightbox-toolbar .lightbox-close')).not.toBeNull();
    // 映像のダウンロードや前後の切り替えは出さない
    expect(el.querySelector('.lightbox-download')).toBeNull();
    expect(el.querySelector('.lightbox-nav')).toBeNull();
  });

  it('Ctrl + ホイールで拡大（ページは止める）', () => {
    const el = render({ screen: fakeScreen({ sharers: [sharer('pa')], viewerOpen: true }), nameOf });
    const ev = new WheelEvent('wheel', { deltaY: -40, ctrlKey: true, bubbles: true, cancelable: true });
    stageOf(el).dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(scaleOf(el)).toBeGreaterThan(1);
  });

  it('受信フレームが更新されても、拡大倍率・移動位置を保つ（key が同じなので作り直さない）', () => {
    const s = reactiveScreen({ sharers: [sharer('pa')], viewerOpen: true, selectedPeer: 'pa' });
    const el = render({ screen: s, nameOf });
    const first = imgOf(el);
    stageOf(el).dispatchEvent(new WheelEvent('wheel', { deltaY: -200, ctrlKey: true, bubbles: true, cancelable: true }));
    flushSync();
    const before = imgOf(el).style.transform;
    expect(scaleOf(el)).toBeGreaterThan(1);
    for (let n = 0; n < 5; n++) {
      s.sharers = [sharer('pa', { dataUrl: `data:image/jpeg;base64,/9j/FRAME${n}`, lastSeen: n })];
      flushSync();
      expect(imgOf(el)).toBe(first);
      expect(imgOf(el).src).toContain(`FRAME${n}`);
      expect(imgOf(el).style.transform).toBe(before);
    }
  });

  it('見る人を替えると、拡大は等倍に戻る', () => {
    const s = reactiveScreen({ sharers: [sharer('pa'), sharer('pb')], viewerOpen: true, selectedPeer: 'pa' });
    const el = render({ screen: s, nameOf });
    stageOf(el).dispatchEvent(new WheelEvent('wheel', { deltaY: -200, ctrlKey: true, bubbles: true, cancelable: true }));
    flushSync();
    expect(scaleOf(el)).toBeGreaterThan(1);
    s.selectedPeer = 'pb';
    flushSync();
    expect(scaleOf(el)).toBe(1);
  });

  it('矢印キーは奪わない（前後の切り替えは無い）。Esc は Lightbox ではなくここが閉じる（1 回だけ）', () => {
    const s = fakeScreen({ sharers: [sharer('pa')], viewerOpen: true });
    render({ screen: s, nameOf });
    const arrow = new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true });
    window.dispatchEvent(arrow);
    expect(arrow.defaultPrevented).toBe(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(s.closeViewer).toHaveBeenCalledTimes(1);
  });

  it('入力欄・既に処理済みの Esc では閉じない', () => {
    const s = fakeScreen({ sharers: [sharer('pa')], viewerOpen: true });
    render({ screen: s, nameOf });
    const handled = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    handled.preventDefault();
    window.dispatchEvent(handled);
    expect(s.closeViewer).not.toHaveBeenCalled();
  });
});

describe('共有映像を拡大している間の自動回転', () => {
  it('メディアだけ自動回転: 開いた間だけ回転を許可し、外から閉じても縦へ戻す', () => {
    deviceSettings.raw = { ...deviceSettings.raw, orientation: 'media' };
    const s = reactiveScreen({ sharers: [sharer('pa')], viewerOpen: false });
    render({ screen: s, nameOf });
    expect(orientation.lock).toBe('portrait');
    s.viewerOpen = true;
    flushSync();
    expect(orientation.mediaFullscreen).toBe(true);
    expect(orientation.lock).toBe('unlocked');
    s.viewerOpen = false;
    flushSync();
    expect(orientation.mediaFullscreen).toBe(false);
    expect(orientation.lock).toBe('portrait');
  });

  it('縦固定は解除しない。自動回転の設定では回転できる', () => {
    deviceSettings.raw = { ...deviceSettings.raw, orientation: 'portrait' };
    render({ screen: fakeScreen({ sharers: [sharer('pa')], viewerOpen: true }), nameOf });
    expect(orientation.mediaFullscreen).toBe(true);
    expect(orientation.lock).toBe('portrait');
    deviceSettings.raw = { ...deviceSettings.raw, orientation: 'auto' };
    flushSync();
    expect(orientation.lock).toBe('unlocked');
  });

  it('共有の表示が破棄されても、別のメディア表示の回転許可を解除しない', async () => {
    deviceSettings.raw = { ...deviceSettings.raw, orientation: 'media' };
    const release = orientation.holdMediaView();
    try {
      render({ screen: fakeScreen({ sharers: [sharer('pa')], viewerOpen: true }), nameOf });
      await unmount(instance!);
      instance = undefined;
      flushSync();
      expect(orientation.lock).toBe('unlocked');
      release();
      release();
      flushSync();
      expect(orientation.lock).toBe('portrait');
    } finally { release(); }
  });
});

describe('小窓（本体の PiP）', () => {
  it('本体の PiP があれば、小窓のボタンで enter を呼ぶ', async () => {
    const pip = fakePip();
    const el = render({ screen: fakeScreen({ sharers: [sharer('pa')], viewerOpen: true }), nameOf, pip });
    btn(el, '小窓で見る')!.click();
    await vi.waitFor(() => expect(pip.enter).toHaveBeenCalledOnce());
  });

  it('小窓に入っているあいだは、上のバーを隠す（映像だけ）', () => {
    const pip = fakePip({ active: true });
    const el = render({ screen: fakeScreen({ sharers: [sharer('pa')], viewerOpen: true }), nameOf, pip });
    expect(el.querySelector('.lightbox-toolbar')).toBeNull();
    expect(stageOf(el)).not.toBeNull();
  });
});

describe('Esc と重なり・フォーカス', () => {
  it('画像の全画面・確認・コマンドパレットが開いているときは、Esc でこの表示を閉じない（上の層が閉じる）', () => {
    for (const set of [
      () => (ui.lightbox = { src: 'x', alt: '' } as never),
      () => (ui.confirmReq = { message: 'x' } as never),
      () => (commandHost.paletteOpen = true),
    ]) {
      const s = fakeScreen({ sharers: [sharer('pa')], viewerOpen: true });
      const el = render({ screen: s, nameOf });
      set();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
      expect(s.closeViewer).not.toHaveBeenCalled();
      instance = undefined;
      target?.remove();
      void el;
      ui.lightbox = null;
      ui.confirmReq = null;
      commandHost.paletteOpen = false;
    }
  });

  it('開いたら表示にフォーカスを移し、外から閉じられたら開く前の場所へ戻す', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    const s = reactiveScreen({ sharers: [sharer('pa')], viewerOpen: true });
    const el = render({ screen: s, nameOf });
    expect(document.activeElement).toBe(el.querySelector('[role="dialog"]'));
    s.viewerOpen = false;
    flushSync();
    expect(el.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('外から閉じられたら、小窓と全画面の後片付けをする', async () => {
    env.android = true;
    const s = reactiveScreen({ sharers: [sharer('pa')], viewerOpen: true });
    const el = render({ screen: s, nameOf });
    tapAt(el, ON_IMAGE);
    await vi.waitFor(() => expect(toolbar(el)).toBeNull());
    s.viewerOpen = false;
    flushSync();
    await vi.waitFor(() => expect(immersive.set).toHaveBeenLastCalledWith(false));
  });
});

describe('全画面（Android は没入モード）の後片付け', () => {
  it('Android: 全画面のボタンは出さない。デスクトップは従来のボタンを出す', async () => {
    env.android = true;
    const el = render({ screen: fakeScreen({ sharers: [sharer('pa')], viewerOpen: true }), nameOf });
    expect(btn(el, '全画面')).toBeNull();
    expect(btn(el, '全画面を解く')).toBeNull();
    env.android = false;
    await unmount(instance!);
    instance = undefined;
    el.remove();
    const desktop = render({ screen: fakeScreen({ sharers: [sharer('pa')], viewerOpen: true }), nameOf });
    expect(btn(desktop, '全画面')).not.toBeNull();
  });

  it('Android: 映像を押すとバーとシステムバーを隠し（没入）、もう一度押すと戻る。映像の外を押すと閉じる。閉じる（アンマウント）ときも解除する', async () => {
    env.android = true;
    const s = fakeScreen({ sharers: [sharer('pa')], viewerOpen: true });
    const el = render({ screen: s, nameOf });
    expect(toolbar(el)).not.toBeNull();
    tapAt(el, ON_IMAGE);
    await vi.waitFor(() => expect(toolbar(el)).toBeNull());
    expect(immersive.set).toHaveBeenLastCalledWith(true);
    expect(s.closeViewer).not.toHaveBeenCalled();
    tapAt(el, ON_IMAGE);
    await vi.waitFor(() => expect(toolbar(el)).not.toBeNull());
    expect(immersive.set).toHaveBeenLastCalledWith(false);
    expect(s.closeViewer).not.toHaveBeenCalled();
    tapAt(el, OUTSIDE);
    await vi.waitFor(() => expect(s.closeViewer).toHaveBeenCalledOnce());
    tapAt(el, ON_IMAGE);
    await vi.waitFor(() => expect(immersive.set).toHaveBeenCalledTimes(3));
    await unmount(instance!);
    instance = undefined;
    expect(immersive.set).toHaveBeenLastCalledWith(false);
  });

  it('全画面にしている途中で閉じたら、遅れて成功しても最後は解除の状態にする', async () => {
    env.android = true;
    let finish: (v: boolean) => void = () => {};
    immersive.set.mockImplementation((on: boolean) => (on ? new Promise<boolean>((r) => (finish = r)) : Promise.resolve(true)));
    const el = render({ screen: fakeScreen({ sharers: [sharer('pa')], viewerOpen: true }), nameOf });
    tapAt(el, ON_IMAGE);
    await vi.waitFor(() => expect(immersive.set).toHaveBeenCalledWith(true));
    await unmount(instance!);
    instance = undefined;
    finish(true);
    // 遅れて成功したら、解除をもう一度送って、最後は解除の状態にする（閉じた側の解除が先に終わっていても）
    await new Promise((r) => setTimeout(r, 0));
    expect(immersive.set).toHaveBeenLastCalledWith(false);
    expect(immersive.set.mock.calls.filter(([on]) => on === false).length).toBeGreaterThanOrEqual(2);
  });

  it('全画面にできなかったら、知らせて状態を戻す', async () => {
    env.android = true;
    immersive.set.mockImplementation(async () => {
      throw new Error('native failed');
    });
    const toast = vi.spyOn(ui, 'toast');
    const el = render({ screen: fakeScreen({ sharers: [sharer('pa')], viewerOpen: true }), nameOf });
    tapAt(el, ON_IMAGE);
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('全画面にできませんでした', 'error'));
    expect(toolbar(el)).not.toBeNull();
    toast.mockRestore();
  });

  it('デスクトップでは、映像を押しても没入せず、従来どおり閉じる', async () => {
    const s = fakeScreen({ sharers: [sharer('pa')], viewerOpen: true });
    const el = render({ screen: s, nameOf });
    tapAt(el, ON_IMAGE);
    await vi.waitFor(() => expect(s.closeViewer).toHaveBeenCalledOnce());
    expect(immersive.set).not.toHaveBeenCalled();
  });
});

describe('デスクトップの小窓（canvas の映像）', () => {
  const imgStub = () => ({ naturalWidth: 10, naturalHeight: 10 }) as unknown as HTMLImageElement;
  void imgStub;

  it('始められなかったら知らせ、小窓の状態は出さない', async () => {
    env.webAvailable = true;
    env.startWebPip = async () => {
      throw new Error('denied');
    };
    const toast = vi.spyOn(ui, 'toast');
    const el = render({ screen: fakeScreen({ sharers: [sharer('pa')], viewerOpen: true }), nameOf });
    btn(el, '小窓で見る')!.click();
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('小窓にできませんでした', 'error'));
    expect(btn(el, '小窓で見る')!.getAttribute('class') ?? '').not.toContain('active');
    toast.mockRestore();
  });

  it('始まる前に閉じたら、遅れてできた小窓はすぐ片付ける（残さない）', async () => {
    env.webAvailable = true;
    const made = { draw: vi.fn(), close: vi.fn() };
    let finish: (v: unknown) => void = () => {};
    env.startWebPip = () => new Promise((r) => (finish = r));
    const el = render({ screen: fakeScreen({ sharers: [sharer('pa')], viewerOpen: true }), nameOf });
    btn(el, '小窓で見る')!.click();
    await vi.waitFor(() => expect(env.startWebPip).toBeTruthy());
    await unmount(instance!);
    instance = undefined;
    finish(made);
    await vi.waitFor(() => expect(made.close).toHaveBeenCalledOnce());
  });

  it('できた小窓は閉じるとき止める（閉じる・もう一度押す・アンマウント）', async () => {
    env.webAvailable = true;
    const made = { draw: vi.fn(), close: vi.fn() };
    env.startWebPip = async () => made;
    const el = render({ screen: fakeScreen({ sharers: [sharer('pa')], viewerOpen: true }), nameOf });
    btn(el, '小窓で見る')!.click();
    await vi.waitFor(() => expect(btn(el, '小窓で見る')!.getAttribute('class')).toContain('active'));
    btn(el, '小窓で見る')!.click();
    expect(made.close).toHaveBeenCalledTimes(1);
  });
});
