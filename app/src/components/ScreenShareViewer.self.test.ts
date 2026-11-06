// @vitest-environment jsdom
// 自分の映像の全画面（このデバイスの画面・カメラ）。カメラの切り替えは、ここ（全画面）の操作に置く
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';
import ScreenShareViewer from './ScreenShareViewer.svelte';
import { ui } from '../lib/stores/ui.svelte';
import { LOCAL_VIEW } from '../lib/call/screen/types';
import { fakeScreen, sharer } from './testing/screenFake';
import { reactiveScreen } from './testing/reactiveScreen.svelte';

const env = vi.hoisted(() => ({ android: false }));
const commandHost = vi.hoisted(() => ({ paletteOpen: false }));
const immersive = vi.hoisted(() => ({ set: vi.fn(async (_on: boolean) => true) }));
vi.mock('../lib/commandHost.svelte', () => ({ commandHost }));
vi.mock('../lib/platform', async (orig) => ({ ...(await orig<object>()), isAndroid: () => env.android }));
vi.mock('../lib/systemBars', () => ({ setImmersive: immersive.set }));
vi.mock('../lib/call/screen/webPip', () => ({ webPipAvailable: () => true, startWebPip: () => Promise.reject(new Error('no pip')) }));

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;
const nameOf = (id: string) => `名前:${id}`;
const frame = { mime: 'image/png', data: 'QUJD' } as never;

function render(props: object): HTMLElement {
  target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(ScreenShareViewer as unknown as Component<Record<string, unknown>>, { target, props: { nameOf, myUserId: 'me', ...props } });
  flushSync();
  return target;
}
const btn = (el: HTMLElement, label: string) => {
  flushSync();
  return el.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
};

beforeEach(() => {
  Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: vi.fn(async () => {}) });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 });
});
afterEach(async () => {
  if (instance) await unmount(instance);
  target?.remove();
  instance = undefined;
  target = undefined;
  env.android = false;
  ui.pluginBack = [];
  immersive.set.mockClear();
});

describe('自分の映像の全画面', () => {
  it('自分の画面共有: 映像（フレーム）をほかの人の映像と同じ表示で出し、見出しは「自分の画面」（切り替えは置かない）', () => {
    const s = fakeScreen({ sharing: true, localFrame: frame, sharers: [sharer('o1', { userId: 'other' })], viewerOpen: true, selectedPeer: LOCAL_VIEW });
    const el = render({ screen: s });
    expect(el.querySelector<HTMLImageElement>('.lightbox-slide-current .image-viewer-image')!.src).toBe('data:image/png;base64,QUJD');
    expect(el.querySelector('[role="radio"], .segmented')).toBeNull();
    expect(el.querySelector('.screen-viewer-title')!.textContent).toBe('自分の画面');
  });

  it('自分の別のデバイスの映像を開いたときの見出しは、名前に「（別のデバイス）」を付ける', () => {
    const s = fakeScreen({ sharing: true, localFrame: frame, sharers: [sharer('o1', { userId: 'other' }), sharer('m1', { userId: 'me' })], viewerOpen: true, selectedPeer: 'm1' });
    const el = render({ screen: s });
    expect(el.querySelector('.screen-viewer-title')!.textContent).toBe('名前:meの画面（別のデバイス）');
  });

  it('自分のカメラ: 消音の動画を出し、カメラの切り替えは canSwitchCamera のときだけ全画面の操作に出る（押すと switchCamera）', () => {
    const stream = {} as MediaStream;
    const s = fakeScreen({ sharing: true, source: 'camera', localStream: stream, canSwitchCamera: true, viewerOpen: true, selectedPeer: LOCAL_VIEW });
    const el = render({ screen: s });
    const video = el.querySelector<HTMLVideoElement>('.screen-viewer-camera-video')!;
    expect(video.muted).toBe(true);
    expect(video.srcObject).toBe(stream);
    expect(btn(el, '小窓で見る')?.disabled ?? true).toBe(true);
    btn(el, 'カメラを切り替え')!.click();
    expect(s.switchCamera).toHaveBeenCalledOnce();
  });

  it('カメラを共有していても、切り替えられないときは切り替えのボタンを出さない', () => {
    const off = render({ screen: fakeScreen({ sharing: true, source: 'camera', localStream: {} as MediaStream, canSwitchCamera: false, viewerOpen: true, selectedPeer: LOCAL_VIEW }) });
    expect(btn(off, 'カメラを切り替え')).toBeNull();
  });

  it('共有していなければ自分の映像は出ない（選択が自分でも、ほかの人の映像へ）', () => {
    const s = fakeScreen({ sharing: false, sharers: [sharer('o1', { userId: 'other' })], viewerOpen: true, selectedPeer: LOCAL_VIEW });
    const el = render({ screen: s });
    expect(el.textContent).toContain('名前:otherの画面');
    expect(btn(el, 'カメラを切り替え')).toBeNull();
  });

  it('Android: 自分のカメラの動画を押すと没入（バーを隠す）、もう一度で戻る。動画の外を押すと閉じる', async () => {
    env.android = true;
    const s = fakeScreen({ sharing: true, source: 'camera', localStream: {} as MediaStream, canSwitchCamera: true, viewerOpen: true, selectedPeer: LOCAL_VIEW });
    const el = render({ screen: s });
    const video = el.querySelector<HTMLVideoElement>('.screen-viewer-camera-video')!;
    video.click();
    await vi.waitFor(() => expect(el.querySelector('.lightbox-toolbar')).toBeNull());
    expect(immersive.set).toHaveBeenLastCalledWith(true);
    video.click();
    await vi.waitFor(() => expect(el.querySelector('.lightbox-toolbar')).not.toBeNull());
    expect(immersive.set).toHaveBeenLastCalledWith(false);
    expect(s.closeViewer).not.toHaveBeenCalled();
    el.querySelector<HTMLElement>('.screen-viewer-camera')!.click();
    expect(s.closeViewer).toHaveBeenCalledOnce();
  });

  it('デスクトップ: 自分のカメラの動画を押すと閉じる', () => {
    const s = fakeScreen({ sharing: true, source: 'camera', localStream: {} as MediaStream, viewerOpen: true, selectedPeer: LOCAL_VIEW });
    render({ screen: s }).querySelector<HTMLVideoElement>('.screen-viewer-camera-video')!.click();
    expect(s.closeViewer).toHaveBeenCalledOnce();
    expect(immersive.set).not.toHaveBeenCalled();
  });
});

describe('カメラを切り替えたとき', () => {
  it('全画面の映像も新しいストリームに替わり、再生し直す（消えない）', async () => {
    const play = vi.fn(async () => {});
    Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: play });
    const a = {} as MediaStream;
    const b = {} as MediaStream;
    const s = reactiveScreen({ sharing: true, source: 'camera', localStream: a, canSwitchCamera: true, viewerOpen: true, selectedPeer: LOCAL_VIEW });
    const el = render({ screen: s });
    expect(el.querySelector<HTMLVideoElement>('.screen-viewer-camera-video')!.srcObject).toBe(s.localStream);
    const before = play.mock.calls.length;
    s.localStream = b;
    flushSync();
    expect(el.querySelector<HTMLVideoElement>('.screen-viewer-camera-video')!.srcObject).toBe(s.localStream);
    expect(s.localStream).not.toBe(a);
    expect(play.mock.calls.length).toBeGreaterThan(before);
  });
});
