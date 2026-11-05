// @vitest-environment jsdom
// 共有の全画面の表示: 開く・閉じる（Esc・戻る・閉じるボタン）、見る画面の切り替え、拡大・移動（ボタン・ホイール・ダブルタップ）、小窓（本体の PiP）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';
import ScreenShareViewer from './ScreenShareViewer.svelte';
import { ui } from '../lib/stores/ui.svelte';

import { fakeScreen, sharer } from './testing/screenFake';
import { reactiveScreen } from './testing/reactiveScreen.svelte';
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
const stageOf = (el: HTMLElement) => el.querySelector<HTMLElement>('.screen-viewer-stage')!;
/** 操作のあとの表示を読む（Svelte の更新を待たずに読めるよう、ここで反映させる） */
const imgOf = (el: HTMLElement) => {
  flushSync();
  return el.querySelector<HTMLImageElement>('.screen-viewer-image')!;
};
/** 拡大の倍率は transform の scale から読む */
const scaleOf = (el: HTMLElement) => Number(/scale\(([\d.]+)\)/.exec(imgOf(el).style.transform)?.[1] ?? '1');

function pointer(type: string, el: HTMLElement, x: number, y: number, id = 1): void {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperty(ev, 'pointerId', { value: id });
  el.dispatchEvent(ev);
}

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
    expect(btn(el, '拡大')!.disabled).toBe(true);
  });

  it('2 人以上が共有しているときは、上の切り替えで見る人を選べる', () => {
    const s = fakeScreen({ sharers: [sharer('pa'), sharer('pb')], viewerOpen: true, selectedPeer: 'pa' });
    const el = render({ screen: s, nameOf });
    const tabs = el.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    expect(tabs.length).toBe(2);
    tabs[1]!.click();
    expect(s.selectPeer).toHaveBeenCalledWith('pb');
  });
});

describe('拡大・移動', () => {
  it('+・-・0 キーで受信映像を拡大・縮小・リセットできる', () => {
    const el = render({ screen: fakeScreen({ sharers: [sharer('pa')], viewerOpen: true }), nameOf });
    const plus = new KeyboardEvent('keydown', { key: '+', cancelable: true }); window.dispatchEvent(plus);
    expect(plus.defaultPrevented).toBe(true); expect(scaleOf(el)).toBeCloseTo(1.25);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '-', cancelable: true }));
    expect(scaleOf(el)).toBeCloseTo(1);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '=', cancelable: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '0', cancelable: true }));
    expect(scaleOf(el)).toBe(1);
  });

  it('入力欄・既に処理済みのキーではズームせず、上の層が閉じた Esc でも閲覧を閉じ直さない', () => {
    const s = fakeScreen({ sharers: [sharer('pa')], viewerOpen: true });
    const el = render({ screen: s, nameOf });
    const input = document.createElement('input'); el.append(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true, cancelable: true }));
    expect(scaleOf(el)).toBe(1);
    const handled = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    handled.preventDefault(); window.dispatchEvent(handled);
    expect(s.closeViewer).not.toHaveBeenCalled();
  });

  it('受信フレームの連続更新と画像読み込みで、拡大倍率・移動位置を等倍へ戻さない', () => {
    const s = reactiveScreen({ sharers: [sharer('pa')], viewerOpen: true, selectedPeer: 'pa' });
    const el = render({ screen: s, nameOf });
    const img = imgOf(el);
    Object.defineProperty(img, 'naturalWidth', { configurable: true, value: 1920 });
    Object.defineProperty(img, 'naturalHeight', { configurable: true, value: 1080 });
    img.dispatchEvent(new Event('load'));
    btn(el, '拡大')!.click();
    const stage = stageOf(el);
    pointer('pointerdown', stage, 100, 100); pointer('pointermove', stage, 150, 120); pointer('pointerup', stage, 150, 120);
    const before = imgOf(el).style.transform;
    expect(scaleOf(el)).toBeGreaterThan(1);
    for (let n = 0; n < 5; n++) {
      s.sharers = [sharer('pa', { dataUrl: `data:image/jpeg;base64,/9j/FRAME${n}`, lastSeen: n })];
      flushSync(); imgOf(el).dispatchEvent(new Event('load')); flushSync();
      expect(imgOf(el).style.transform).toBe(before);
    }
  });

  it('拡大・縮小・等倍のボタンで倍率が変わり、等倍に戻せる', () => {
    const el = render({ screen: fakeScreen({ sharers: [sharer('pa')], viewerOpen: true }), nameOf });
    expect(scaleOf(el)).toBe(1);
    btn(el, '拡大')!.click();
    expect(scaleOf(el)).toBeCloseTo(1.25);
    btn(el, '縮小')!.click();
    expect(scaleOf(el)).toBeCloseTo(1);
    btn(el, '拡大')!.click();
    btn(el, '等倍に戻す')!.click();
    expect(scaleOf(el)).toBe(1);
  });

  it('Ctrl + ホイールで拡大（ページは止める）', () => {
    const el = render({ screen: fakeScreen({ sharers: [sharer('pa')], viewerOpen: true }), nameOf });
    const ev = new WheelEvent('wheel', { deltaY: -40, ctrlKey: true, bubbles: true, cancelable: true });
    stageOf(el).dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(scaleOf(el)).toBeGreaterThan(1);
  });

  it('ダブルタップ（短い間隔・近い場所の二回）で拡大し、もう一度で等倍に戻る', () => {
    const el = render({ screen: fakeScreen({ sharers: [sharer('pa')], viewerOpen: true }), nameOf });
    const st = stageOf(el);
    pointer('pointerdown', st, 10, 10);
    pointer('pointerup', st, 10, 10);
    pointer('pointerdown', st, 12, 11, 2);
    pointer('pointerup', st, 12, 11, 2);
    expect(scaleOf(el)).toBeCloseTo(2.5);
    pointer('pointerdown', st, 10, 10, 3);
    pointer('pointerup', st, 10, 10, 3);
    pointer('pointerdown', st, 10, 10, 4);
    pointer('pointerup', st, 10, 10, 4);
    expect(scaleOf(el)).toBe(1);
  });

  it('拡大していないときのドラッグでは移動しない（画面の大きさの中に収まる）', () => {
    const el = render({ screen: fakeScreen({ sharers: [sharer('pa')], viewerOpen: true }), nameOf });
    const st = stageOf(el);
    pointer('pointerdown', st, 0, 0);
    pointer('pointermove', st, 200, 100);
    pointer('pointerup', st, 200, 100);
    expect(imgOf(el).style.transform).toBe('translate(0px, 0px) scale(1)');
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
    expect(el.querySelector('.screen-viewer-bar')).toBeNull();
    expect(el.querySelector('.screen-viewer-stage')).not.toBeNull();
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
    btn(el, '全画面')!.click();
    await vi.waitFor(() => expect(btn(el, '全画面を解く')).not.toBeNull());
    s.viewerOpen = false;
    flushSync();
    await vi.waitFor(() => expect(immersive.set).toHaveBeenLastCalledWith(false));
  });
});

describe('全画面（Android は没入モード）の後片付け', () => {
  it('Android: 全画面にして、もう一度で解除。閉じる（アンマウント）ときも解除する', async () => {
    env.android = true;
    const el = render({ screen: fakeScreen({ sharers: [sharer('pa')], viewerOpen: true }), nameOf });
    btn(el, '全画面')!.click();
    await vi.waitFor(() => expect(btn(el, '全画面を解く')).not.toBeNull());
    expect(immersive.set).toHaveBeenLastCalledWith(true);
    btn(el, '全画面を解く')!.click();
    await vi.waitFor(() => expect(btn(el, '全画面')).not.toBeNull());
    expect(immersive.set).toHaveBeenLastCalledWith(false);
    btn(el, '全画面')!.click();
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
    btn(el, '全画面')!.click();
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
    btn(el, '全画面')!.click();
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('全画面にできませんでした', 'error'));
    expect(btn(el, '全画面')).not.toBeNull();
    toast.mockRestore();
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
