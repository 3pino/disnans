// @vitest-environment jsdom
// 画面共有の押すボタン（通話のバー・通話の画面）と、見るための入口。押すとエンジンの操作を呼ぶ（見た目は確かめない）
import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';
import ScreenShareControls from './ScreenShareControls.svelte';
import { fakeScreen } from '../test-support/screenFake';

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

  it('カメラを共有中でも、通話の操作の列にはカメラの切り替えを出さない（自分の映像の見出しと全画面に置く）', () => {
    const s = fakeScreen({ sharing: true, source: 'camera', canSwitchCamera: true });
    const el = render(ScreenShareControls, { screen: s });
    expect(button(el, 'カメラを切り替え')).toBeNull();
    expect(s.switchCamera).not.toHaveBeenCalled();
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
