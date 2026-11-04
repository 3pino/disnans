// @vitest-environment jsdom
// 画面共有の押すボタン（通話のバー・通話の画面）と、見るための入口。押すとエンジンの操作を呼ぶ（見た目は確かめない）
import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';
import ScreenShareControls from './ScreenShareControls.svelte';
import ScreenShareEntrance from './ScreenShareEntrance.svelte';
import { fakeScreen, sharer } from './testing/screenFake';

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;

function render<P extends object>(component: unknown, props: P): HTMLElement {
  target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(component as Component<Record<string, unknown>>, { target, props: props as Record<string, unknown> });
  flushSync();
  return target;
}
const button = (el: HTMLElement, label: string) => el.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

afterEach(async () => {
  if (instance) await unmount(instance);
  target?.remove();
  instance = undefined;
  target = undefined;
});

describe('画面共有の押すボタン', () => {
  it('共有していないときは「画面を共有」「カメラを共有」。押すと toggleScreen / toggleCamera', () => {
    const s = fakeScreen();
    const el = render(ScreenShareControls, { screen: s });
    button(el, '画面を共有')!.click();
    button(el, 'カメラを共有')!.click();
    expect(s.toggleScreen).toHaveBeenCalledOnce();
    expect(s.toggleCamera).toHaveBeenCalledOnce();
    expect(button(el, 'カメラを切り替え')).toBeNull();
  });

  it('画面を共有中は「画面の共有を止める」。押すと toggleScreen（止める）', () => {
    const s = fakeScreen({ sharing: true, source: 'screen' });
    const el = render(ScreenShareControls, { screen: s });
    button(el, '画面の共有を止める')!.click();
    expect(s.toggleScreen).toHaveBeenCalledOnce();
  });

  it('カメラの共有中は、切り替えは canSwitchCamera のときだけ出る', () => {
    const off = fakeScreen({ sharing: true, source: 'camera', canSwitchCamera: false });
    expect(button(render(ScreenShareControls, { screen: off }), 'カメラを切り替え')).toBeNull();
    const on = fakeScreen({ sharing: true, source: 'camera', canSwitchCamera: true });
    const el = render(ScreenShareControls, { screen: on });
    button(el, 'カメラを切り替え')!.click();
    expect(on.switchCamera).toHaveBeenCalledOnce();
  });

  it('開始の途中・切り替えの途中は押せない', () => {
    const el = render(ScreenShareControls, { screen: fakeScreen({ starting: true }) });
    expect(button(el, '画面を共有')!.disabled).toBe(true);
    expect(button(el, 'カメラを共有')!.disabled).toBe(true);
  });

  it('対応していない共有（canScreen / canCamera が false）のボタンは出さない', () => {
    const el = render(ScreenShareControls, { screen: fakeScreen({ canScreen: false, canCamera: false }) });
    expect(el.querySelectorAll('button').length).toBe(0);
  });
});

describe('見る入口（通話のバー）', () => {
  it('共有者がいて見ていないときだけ出し、押すと最初の人の表示を開く', () => {
    const s = fakeScreen({ sharers: [sharer('pa')] });
    const el = render(ScreenShareEntrance, { screen: s, nameOf: () => 'Aさん' });
    const b = button(el, 'Aさんの画面を見る');
    expect(b).not.toBeNull();
    b!.click();
    expect(s.openViewer).toHaveBeenCalledWith('pa');
  });

  it('共有者がいないとき・見ているときは出さない', () => {
    expect(render(ScreenShareEntrance, { screen: fakeScreen(), nameOf: () => 'A' }).querySelector('button')).toBeNull();
    instance = undefined;
    target?.remove();
    const el = render(ScreenShareEntrance, { screen: fakeScreen({ sharers: [sharer('pa')], viewerOpen: true }), nameOf: () => 'A' });
    expect(el.querySelector('button')).toBeNull();
  });

  it('カメラの共有は「のカメラを見る」、複数人なら「ほか」', () => {
    const cam = render(ScreenShareEntrance, { screen: fakeScreen({ sharers: [sharer('pa', { source: 'camera' })] }), nameOf: () => 'Aさん' });
    expect(button(cam, 'Aさんのカメラを見る')).not.toBeNull();
    instance = undefined;
    target?.remove();
    const many = render(ScreenShareEntrance, { screen: fakeScreen({ sharers: [sharer('pa'), sharer('pb')] }), nameOf: () => 'Aさん' });
    expect(button(many, 'Aさんの画面ほか（見る）')).not.toBeNull();
  });
});
