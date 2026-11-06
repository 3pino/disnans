// @vitest-environment jsdom
// 通話の画面の下半分に並べる共有映像（正方形の舞台・順番・押すと全画面）。大きさ・配置は Chromium（app/scripts/feedback-ui-check.mjs）で確かめる
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import CallStreams from './CallStreams.svelte';
import { LOCAL_VIEW } from '../lib/call/screen/types';
import { fakeScreen, sharer } from './testing/screenFake';
import { reactiveScreen } from './testing/reactiveScreen.svelte';

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;
const nameOf = (id: string) => `名前:${id}`;
beforeEach(() => {
  Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: vi.fn(async () => {}) });
});
afterEach(async () => {
  if (instance) await unmount(instance);
  target?.remove();
  instance = undefined;
  target = undefined;
});
function render(screen: ReturnType<typeof fakeScreen>, myUserId: string | null = 'me'): HTMLElement {
  target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(CallStreams, { target, props: { screen, nameOf, myUserId } });
  flushSync();
  return target;
}
const stages = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>('.screen-stage')];

describe('共有されている映像の並び', () => {
  it('自分の今のデバイス > 自分の別のデバイス > ほかの人の順に出す', () => {
    const s = fakeScreen({
      sharing: true,
      localFrame: { mime: 'image/png', data: 'QUJD' } as never,
      sharers: [sharer('o1', { userId: 'other' }), sharer('m1', { userId: 'me', source: 'camera' })],
    });
    expect(stages(render(s)).map((b) => b.dataset.peer)).toEqual([LOCAL_VIEW, 'm1', 'o1']);
  });
  it('名前と全画面へのラベルを持ち、押すとその映像を全画面で開く', () => {
    const s = fakeScreen({ sharers: [sharer('o1', { userId: 'other' }), sharer('o2', { userId: 'third' })] });
    const el = render(s);
    const second = stages(el)[1]!;
    expect(second.getAttribute('aria-label')).toBe('名前:thirdの画面を全画面で見る');
    expect(second.textContent).toContain('名前:thirdの画面');
    second.click();
    expect(s.openViewer).toHaveBeenCalledWith('o2');
  });
  it('ここでは拡大・移動の操作を持たない（ホイール・ダブルタップを受けない）', () => {
    const el = render(fakeScreen({ sharers: [sharer('o1')] }));
    const wheel = new WheelEvent('wheel', { deltaY: -40, ctrlKey: true, bubbles: true, cancelable: true });
    el.querySelector('.screen-stage')!.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
    expect(el.querySelector('img')!.style.transform).toBe('');
  });
  it('自分のカメラは消音の動画、自分の画面共有は静止画。映像がまだ無ければ待っている表示', () => {
    const stream = {} as MediaStream;
    const camera = render(fakeScreen({ sharing: true, source: 'camera', localStream: stream }));
    const video = camera.querySelector<HTMLVideoElement>('video')!;
    expect(video.muted).toBe(true);
    expect(video.srcObject).toBe(stream);
    instance && void unmount(instance);
    instance = undefined;
    camera.remove();
    const frame = render(fakeScreen({ sharing: true, localFrame: { mime: 'image/png', data: 'QUJD' } as never }));
    expect(frame.querySelector<HTMLImageElement>('img')!.src).toBe('data:image/png;base64,QUJD');
    instance && void unmount(instance);
    instance = undefined;
    frame.remove();
    expect(render(fakeScreen({ sharing: true })).textContent).toContain('映像を待っています');
  });
});

describe('カメラを切り替えたとき（新しいストリームに替わる）', () => {
  it('サムネイルも新しいストリームを入れて再生し直す（映像が消えない）', async () => {
    const play = vi.fn(async () => {});
    Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: play });
    const a = {} as MediaStream;
    const b = {} as MediaStream;
    const s = reactiveScreen({ sharing: true, source: 'camera', localStream: a });
    const el = render(s as never);
    const video = el.querySelector<HTMLVideoElement>('video')!;
    expect(video.srcObject).toBe(s.localStream);
    const before = play.mock.calls.length;
    s.localStream = b;
    flushSync();
    expect(el.querySelector<HTMLVideoElement>('video')!.srcObject).toBe(s.localStream);
    expect(s.localStream).not.toBe(a);
    expect(play.mock.calls.length).toBeGreaterThan(before);
  });
});
