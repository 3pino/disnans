// @vitest-environment jsdom
// 通話画面内の受信映像の拡大・移動と、「大きく見る」の入口。自分の映像と停止・切り替えも確認する
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount, type Component } from 'svelte';
import ScreenSharePreview from './ScreenSharePreview.svelte';
import { fakeScreen, sharer } from './testing/screenFake';
import { reactiveScreen } from './testing/reactiveScreen.svelte';

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;

function render(props: object): HTMLElement {
  target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(ScreenSharePreview as unknown as Component<Record<string, unknown>>, { target, props: props as Record<string, unknown> });
  flushSync();
  return target;
}
const nameOf = () => 'Aさん';

beforeEach(() => {
  // jsdom は play を持たない（カメラの映像を入れたときに呼ばれる）
  Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: vi.fn(async () => {}) });
  // 舞台の大きさと画像の元の大きさ（jsdom は寸法を持たない）
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get: () => 1600 });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', { configurable: true, get: () => 900 });
});

/** ポインターの操作（jsdom は PointerEvent を持たないので、MouseEvent に pointerId を足す） */
function pointer(type: string, el: Element, x: number, y: number, id = 1): void {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperty(ev, 'pointerId', { value: id });
  el.dispatchEvent(ev);
}
const stageOf = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-testid="screen-stage"]')!;
const imgOf = (el: HTMLElement) => el.querySelector<HTMLImageElement>('[data-testid="screen-stage"] img')!;
/** 表示の倍率（transform の scale を読む） */
const scaleOf = (el: HTMLElement) => Number(/scale\(([\d.]+)\)/.exec(imgOf(el).style.transform)?.[1] ?? '1');
const translateOf = (el: HTMLElement) => /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(imgOf(el).style.transform)!.slice(1).map(Number);
afterEach(async () => {
  if (instance) await unmount(instance);
  target?.remove();
  instance = undefined;
  target = undefined;
});

describe('共有されている画面の表示（埋め込み）', () => {
  it('画面が来ていれば映像を出し、「大きく見る」で全画面を開く（映像そのものを押しても開かない）', () => {
    const s = fakeScreen({ sharers: [sharer('pa')] });
    const el = render({ screen: s, nameOf });
    const img = el.querySelector<HTMLImageElement>('.screen-embedded img');
    expect(img?.src).toContain('data:image/jpeg');
    stageOf(el).click();
    expect(s.openViewer).not.toHaveBeenCalled();
    el.querySelector<HTMLButtonElement>('button[aria-label="Aさんの画面を大きく見る"]')!.click();
    expect(s.openViewer).toHaveBeenCalledWith('pa');
  });

  it('Ctrl（Meta）+ ホイールで、その場で拡大できる（ページは止める）', async () => {
    const el = render({ screen: fakeScreen({ sharers: [sharer('pa')] }), nameOf });
    const ev = new WheelEvent('wheel', { deltaY: -40, ctrlKey: true, bubbles: true, cancelable: true });
    stageOf(el).dispatchEvent(ev);
    await tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(ev.defaultPrevented).toBe(true);
    expect(scaleOf(el)).toBeGreaterThan(1);
  });

  it('埋め込みでは、等倍のときの修飾キーなしのホイールは拡大せず、ページのスクロールに譲る', async () => {
    const el = render({ screen: fakeScreen({ sharers: [sharer('pa')] }), nameOf });
    const ev = new WheelEvent('wheel', { deltaY: -40, bubbles: true, cancelable: true });
    stageOf(el).dispatchEvent(ev);
    await tick();
    expect(ev.defaultPrevented).toBe(false);
    expect(scaleOf(el)).toBe(1);
  });

  it('ダブルタップで 2.5 倍、もう一度で等倍に戻る', async () => {
    const el = render({ screen: fakeScreen({ sharers: [sharer('pa')] }), nameOf });
    const st = stageOf(el);
    const tap = async (id: number) => {
      pointer('pointerdown', st, 10, 10, id);
      pointer('pointerup', st, 10, 10, id);
      await tick();
    };
    await tap(1);
    expect(scaleOf(el)).toBe(1);
    await tap(2);
    expect(scaleOf(el)).toBeCloseTo(2.5);
    await tap(3);
    expect(scaleOf(el)).toBeCloseTo(2.5);
    await tap(4);
    expect(scaleOf(el)).toBe(1);
  });

  it('二本の指で広げると拡大する', async () => {
    const el = render({ screen: fakeScreen({ sharers: [sharer('pa')] }), nameOf });
    const st = stageOf(el);
    pointer('pointerdown', st, -50, 0, 1);
    await tick();
    pointer('pointerdown', st, 50, 0, 2);
    await tick();
    pointer('pointermove', st, -100, 0, 1);
    await tick();
    pointer('pointermove', st, 100, 0, 2);
    await tick();
    expect(scaleOf(el)).toBeGreaterThan(1.5);
    pointer('pointerup', st, 100, 0, 2);
    await tick();
    pointer('pointerup', st, -100, 0, 1);
    await tick();
  });

  it('拡大中は指でドラッグすると移動する。等倍に戻すと移動も消える', async () => {
    const el = render({ screen: fakeScreen({ sharers: [sharer('pa')] }), nameOf });
    const st = stageOf(el);
    // 画像の読み込み（元の大きさ 1600×900 が分かる）
    imgOf(el).dispatchEvent(new Event('load'));
    stageOf(el).dispatchEvent(new WheelEvent('wheel', { deltaY: -200, ctrlKey: true, bubbles: true, cancelable: true }));
    await tick();
    await tick();
    expect(scaleOf(el)).toBeGreaterThan(1);
    pointer('pointerdown', st, 0, 0, 1);
    await tick();
    pointer('pointermove', st, 30, 0, 1);
    await tick();
    pointer('pointerup', st, 30, 0, 1);
    await tick();
    await tick();
    expect(translateOf(el)[0]).not.toBe(0);
    stageOf(el).dispatchEvent(new WheelEvent('wheel', { deltaY: 2000, ctrlKey: true, bubbles: true, cancelable: true }));
    await tick();
    await tick();
    expect(scaleOf(el)).toBe(1);
    expect(translateOf(el)).toEqual([0, 0]);
  });

  it('同じ配信者のフレームが更新されても拡大・移動を維持する', () => {
    const s = reactiveScreen({ sharers: [sharer('pa')], selectedPeer: 'pa' });
    const el = render({ screen: s, nameOf });
    imgOf(el).dispatchEvent(new Event('load')); flushSync();
    stageOf(el).dispatchEvent(new WheelEvent('wheel', { deltaY: -200, ctrlKey: true, bubbles: true, cancelable: true })); flushSync();
    pointer('pointerdown', stageOf(el), 0, 0); pointer('pointermove', stageOf(el), 30, 0); pointer('pointerup', stageOf(el), 30, 0); flushSync();
    const before = imgOf(el).style.transform;
    expect(scaleOf(el)).toBeGreaterThan(1); expect(translateOf(el)[0]).not.toBe(0);
    for (let n = 0; n < 5; n++) {
      s.sharers = [sharer('pa', { dataUrl: `data:image/jpeg;base64,/9j/NEW${n}` })]; flushSync();
      imgOf(el).dispatchEvent(new Event('load')); flushSync();
      expect(imgOf(el).style.transform).toBe(before);
    }
  });

  it('画面の相手を替えると、拡大は元に戻る（別の画面を拡大したまま出さない）', async () => {
    const s = reactiveScreen({ sharers: [sharer('pa'), sharer('pb')], selectedPeer: 'pa' });
    const el = render({ screen: s, nameOf });
    stageOf(el).dispatchEvent(new WheelEvent('wheel', { deltaY: -200, ctrlKey: true, bubbles: true, cancelable: true }));
    await tick();
    await tick();
    expect(scaleOf(el)).toBeGreaterThan(1);
    s.selectedPeer = 'pb';
    await tick();
    await tick();
    expect(scaleOf(el)).toBe(1);
  });

  it('映像がまだ無いときは「映像を待っています」', async () => {
    const el = render({ screen: fakeScreen({ sharers: [sharer('pa', { dataUrl: null })] }), nameOf });
    expect(el.querySelector('.screen-embedded img')).toBeNull();
    expect(el.textContent).toContain('映像を待っています');
  });

  it('共有者がいなければ何も出さない', async () => {
    expect(render({ screen: fakeScreen(), nameOf }).children.length).toBe(0);
  });
});

describe('自分の映像', () => {
  it('自分が共有していなければ出さない', () => {
    expect(render({ screen: fakeScreen({ localFrame: { data: 'QUJD', mime: 'image/jpeg', width: 1, height: 1 } }), nameOf }).querySelector('.screen-self')).toBeNull();
  });

  it('画面の共有中は、プレビューの画像と「共有を止める」。押すと stop', () => {
    const s = fakeScreen({ sharing: true, source: 'screen', localFrame: { data: 'QUJD', mime: 'image/jpeg', width: 1, height: 1 } });
    const el = render({ screen: s, nameOf });
    expect(el.querySelector<HTMLImageElement>('.screen-self img')?.src).toContain('data:image/jpeg;base64,QUJD');
    el.querySelector<HTMLButtonElement>('button[aria-label="共有を止める"]')!.click();
    expect(s.stop).toHaveBeenCalledOnce();
    expect(el.querySelector('button[aria-label="カメラを切り替え"]')).toBeNull();
  });

  it('カメラの共有中は映像（srcObject）を入れ、切り替えは canSwitchCamera のときだけ', () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const off = render({ screen: fakeScreen({ sharing: true, source: 'camera', localStream: stream, canSwitchCamera: false }), nameOf });
    expect(off.querySelector<HTMLVideoElement>('video')?.srcObject).toBe(stream);
    expect(off.querySelector('button[aria-label="カメラを切り替え"]')).toBeNull();
    instance = undefined;
    target?.remove();
    const s = fakeScreen({ sharing: true, source: 'camera', localStream: stream, canSwitchCamera: true });
    const el = render({ screen: s, nameOf });
    el.querySelector<HTMLButtonElement>('button[aria-label="カメラを切り替え"]')!.click();
    expect(s.switchCamera).toHaveBeenCalledOnce();
  });
});
