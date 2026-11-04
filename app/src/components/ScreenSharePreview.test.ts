// @vitest-environment jsdom
// 通話の画面の中の表示: 共有されている画面を押すと全画面で開く。自分が共有しているときは自分の映像と止める・切り替え
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';
import ScreenSharePreview from './ScreenSharePreview.svelte';
import { fakeScreen, sharer } from './testing/screenFake';

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
});
afterEach(async () => {
  if (instance) await unmount(instance);
  target?.remove();
  instance = undefined;
  target = undefined;
});

describe('共有されている画面の表示（埋め込み）', () => {
  it('画面が来ていれば映像を出し、押すと全画面で開く', () => {
    const s = fakeScreen({ sharers: [sharer('pa')] });
    const el = render({ screen: s, nameOf });
    const img = el.querySelector<HTMLImageElement>('.screen-embedded img');
    expect(img?.src).toContain('data:image/jpeg');
    el.querySelector<HTMLButtonElement>('.screen-embedded')!.click();
    expect(s.openViewer).toHaveBeenCalledWith('pa');
  });

  it('映像がまだ無いときは「映像を待っています」', () => {
    const el = render({ screen: fakeScreen({ sharers: [sharer('pa', { dataUrl: null })] }), nameOf });
    expect(el.querySelector('.screen-embedded img')).toBeNull();
    expect(el.textContent).toContain('映像を待っています');
  });

  it('共有者がいなければ何も出さない', () => {
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
